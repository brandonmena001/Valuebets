import { createHash } from "node:crypto";
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import {
  db,
  matchesTable,
  matchStatsTable,
  oddsQuotesTable,
  playerMatchStatsTable,
  providerTournamentsTable,
  sourceStatusTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import {
  apiFootballLeagues,
  apiFootballGet,
  fetchLeagueFixtures,
  fetchMatchStatistics,
  fetchPlayerStatistics,
  ProviderError,
  type LeagueCode,
  type NormalizedFixture,
  type ProviderQuota,
} from "./api-football";
import {
  fetchFootballTournaments,
  fetchFootballBookmakers,
  fetchFootballMarkets,
  fetchFootballParticipants,
  fetchTournamentOdds,
  type OddsPapiBookmaker,
  type OddsPapiMarket,
  type NormalizedOddsEvent,
  type OddsPapiQuota,
  type TournamentRef,
} from "./oddspapi";
import { describeError } from "../lib/error-detail";
import { importFootballData } from "./football-data";
import { refreshModelPredictions } from "./value-model";

export type SyncScope = "all" | "fixtures" | "odds" | "stats";
export type ProviderName = "api-football" | "oddspapi";

type SyncOptions = {
  scope: SyncScope;
  providers: ProviderName[];
  scheduled?: boolean;
};

const API_FOOTBALL_LOCAL_DAILY_CAP = 80;
const ODDSPAPI_LOCAL_MONTHLY_CAP = 200;
const FIXTURE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ODDS_INTERVAL_MS = 8 * 60 * 60 * 1000;
const MANUAL_COOLDOWN_MS = 5 * 60 * 1000;
const ODDSPAPI_REFERENCE_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

let activeRun: Promise<void> | null = null;
let schedulerStarted = false;
let lastFixtureRunAt = 0;
let lastStatsRunAt = 0;
let lastOddsRunAt = 0;
let lastManualRunAt = 0;
let nextScheduledAt = new Date(Date.now() + 15_000);
let oddsReferenceCache:
  | {
      loadedAt: number;
      bookmakers: OddsPapiBookmaker[];
      participants: Record<string, string>;
      markets: OddsPapiMarket[];
    }
  | null = null;

const providerKeys: Record<ProviderName, string | undefined> = {
  "api-football": process.env.API_FOOTBALL_KEY,
  oddspapi: process.env.ODDSPAPI_API_KEY,
};
type TaskResult = { records: number; errors: string[]; succeeded: boolean };

function providerPeriod(provider: ProviderName, now = new Date()): Date {
  if (provider === "api-football") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function periodKey(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

function defaultLimit(provider: ProviderName): number {
  return provider === "api-football" ? API_FOOTBALL_LOCAL_DAILY_CAP : ODDSPAPI_LOCAL_MONTHLY_CAP;
}

async function ensureSourceRow(provider: ProviderName): Promise<void> {
  const configured = Boolean(providerKeys[provider]);
  const [existing] = await db
    .select()
    .from(sourceStatusTable)
    .where(eq(sourceStatusTable.provider, provider))
    .limit(1);
  if (existing) {
    if (!configured && existing.state !== "unconfigured") {
      await db
        .update(sourceStatusTable)
        .set({ state: "unconfigured", message: "Falta la credencial de este proveedor." })
        .where(eq(sourceStatusTable.provider, provider));
    }
    return;
  }
  await db.insert(sourceStatusTable).values({
    provider,
    state: configured ? "waiting" : "unconfigured",
    recordsCollected: 0,
    requestsUsed: 0,
    requestLimit: null,
    requestsRemaining: null,
    quotaPeriodStart: providerPeriod(provider),
    message: configured
      ? "Credencial disponible; esperando la primera sincronización."
      : "Falta la credencial de este proveedor.",
  });
}

async function sourceRecord(provider: ProviderName) {
  await ensureSourceRow(provider);
  const [row] = await db
    .select()
    .from(sourceStatusTable)
    .where(eq(sourceStatusTable.provider, provider))
    .limit(1);
  return row;
}

async function updateSource(
  provider: ProviderName,
  values: Partial<typeof sourceStatusTable.$inferInsert>,
): Promise<void> {
  await ensureSourceRow(provider);
  await db
    .update(sourceStatusTable)
    .set(values)
    .where(eq(sourceStatusTable.provider, provider));
}

async function reserveProviderRequest(provider: ProviderName): Promise<boolean> {
  const row = await sourceRecord(provider);
  if (!providerKeys[provider]) return false;
  const now = new Date();
  const period = providerPeriod(provider, now);
  const samePeriod = periodKey(row.quotaPeriodStart) === periodKey(period);
  const used = samePeriod ? row.requestsUsed : 0;
  const localCap = defaultLimit(provider);
  if (used >= localCap || (samePeriod && row.requestsRemaining === 0)) return false;
  await updateSource(provider, {
    requestsUsed: used + 1,
    quotaPeriodStart: period,
    requestsRemaining:
      !samePeriod || row.requestLimit == null
        ? null
        : Math.max(0, row.requestLimit - used - 1),
  });
  return true;
}

async function storeQuota(
  provider: ProviderName,
  quota: ProviderQuota | OddsPapiQuota,
): Promise<void> {
  const row = await sourceRecord(provider);
  await updateSource(provider, {
    requestLimit: quota.requestLimit ?? row.requestLimit,
    requestsRemaining: quota.requestsRemaining ?? row.requestsRemaining,
  });
}

function shortError(error: unknown, provider?: ProviderName): string {
  if (error instanceof Error && (
    error.message.includes("no está configurado") ||
    error.message.includes("límite local")
  )) {
    return error.message;
  }
  if (error instanceof ProviderError && error.statusCode != null) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return `${provider === "oddspapi" ? "OddsPapi" : "API-Football"} rechazó la credencial o el acceso al endpoint (HTTP ${error.statusCode}).`;
    }
    if (error.statusCode === 429) {
      return `${provider === "oddspapi" ? "OddsPapi" : "API-Football"} informó que se alcanzó la cuota (HTTP 429).`;
    }
    if (error.statusCode === 400) {
      return error.message;
    }
    return `${provider === "oddspapi" ? "OddsPapi" : "API-Football"} respondió HTTP ${error.statusCode}.`;
  }
  if (error instanceof ProviderError) {
    return error.message;
  }
  if (error instanceof Error && /timeout|timed out|aborted/i.test(error.name + error.message)) {
    return `La consulta a ${provider === "oddspapi" ? "OddsPapi" : "API-Football"} agotó el tiempo de espera.`;
  }
  const name = provider === "oddspapi" ? "OddsPapi" : "API-Football";
  const detail = describeError(error, [process.env.API_FOOTBALL_KEY, process.env.ODDSPAPI_API_KEY]);
  return `No se pudo conectar con ${name}${detail ? ` (${detail})` : ""}. Revisa la conectividad y el estado del proveedor.`;
}

function apiFootballError(error: unknown): { message: string; statusCode?: number } {
  const statusCode =
    typeof error === "object" && error != null && "statusCode" in error
      ? Number((error as { statusCode?: unknown }).statusCode)
      : undefined;
  const raw = shortError(error, "api-football");
  return {
    message: /free plans? do not have access/i.test(raw)
      ? "El plan gratuito de API-Football no incluye la temporada actual (solo 2022–2024). El historial del modelo se importa de football-data.co.uk; las cuotas siguen llegando de OddsPapi."
      : raw,
    statusCode: Number.isFinite(statusCode) ? statusCode : undefined,
  };
}

async function callApiFootball<T>(
  action: () => Promise<{ quota: ProviderQuota; [key: string]: unknown }>,
): Promise<T> {
  if (!(await reserveProviderRequest("api-football"))) {
    throw new Error("Se alcanzó el límite local de consultas de API-Football.");
  }
  try {
    const result = await action();
    await storeQuota("api-football", result.quota);
    return result as T;
  } catch (error) {
    throw error;
  }
}

async function callOddsPapi<T>(
  action: () => Promise<{ quota: OddsPapiQuota; [key: string]: unknown }>,
): Promise<T> {
  if (!(await reserveProviderRequest("oddspapi"))) {
    throw new Error("Se alcanzó el límite local de consultas de OddsPapi.");
  }
  const result = await action();
  await storeQuota("oddspapi", result.quota);
  return result as T;
}

function matchValues(fixture: NormalizedFixture) {
  return {
    apiFootballFixtureId: fixture.apiFootballFixtureId,
    leagueCode: fixture.leagueCode,
    leagueName: fixture.leagueName,
    country: fixture.country,
    homeTeamApiId: fixture.homeTeamApiId,
    awayTeamApiId: fixture.awayTeamApiId,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    kickoff: fixture.kickoff,
    status: fixture.status,
    homeScore: fixture.homeScore,
    awayScore: fixture.awayScore,
    updatedAt: new Date(),
  };
}

async function saveApiFixture(fixture: NormalizedFixture): Promise<void> {
  const values = matchValues(fixture);
  await db
    .insert(matchesTable)
    .values(values)
    .onConflictDoUpdate({
      target: matchesTable.apiFootballFixtureId,
      set: values,
    });
}

async function saveOddsMatch(event: NormalizedOddsEvent): Promise<number> {
  const start = new Date(event.kickoff.getTime() - 8 * 60 * 60 * 1000);
  const end = new Date(event.kickoff.getTime() + 8 * 60 * 60 * 1000);
  let matched:
    | (typeof matchesTable.$inferSelect)
    | undefined;

  if (event.oddsPapiFixtureId) {
    [matched] = await db
      .select()
      .from(matchesTable)
      .where(eq(matchesTable.oddsPapiFixtureId, event.oddsPapiFixtureId))
      .limit(1);
  }
  if (!matched) {
    const candidates = await db
      .select()
      .from(matchesTable)
      .where(
        and(
          eq(matchesTable.leagueCode, event.leagueCode),
          gte(matchesTable.kickoff, start),
          lte(matchesTable.kickoff, end),
        ),
      );
    const home = normalizeTeam(event.homeTeam);
    const away = normalizeTeam(event.awayTeam);
    matched = candidates.find(
      (candidate) =>
        normalizeTeam(candidate.homeTeam) === home &&
        normalizeTeam(candidate.awayTeam) === away,
    );
  }

  const league = apiFootballLeagues.find((item) => item.code === event.leagueCode);
  const values = {
    oddsPapiFixtureId: event.oddsPapiFixtureId,
    leagueCode: event.leagueCode,
    leagueName: league?.name ?? event.leagueCode,
    country: league?.country ?? "Desconocido",
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam,
    kickoff: event.kickoff,
    status: event.status,
    updatedAt: new Date(),
  };

  if (matched) {
    await db
      .update(matchesTable)
      .set({
        oddsPapiFixtureId:
          matched.oddsPapiFixtureId ?? event.oddsPapiFixtureId,
        updatedAt: new Date(),
      })
      .where(eq(matchesTable.id, matched.id));
    return matched.id;
  }

  const [saved] = await db
    .insert(matchesTable)
    .values(values)
    .onConflictDoUpdate({
      target: matchesTable.oddsPapiFixtureId,
      set: values,
    })
    .returning({ id: matchesTable.id });
  return saved.id;
}

function normalizeTeam(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function syncFixtures(): Promise<TaskResult> {
  const errors: string[] = [];
  let records = 0;
  let succeeded = false;
  for (const league of apiFootballLeagues) {
    try {
      const result = await callApiFootball(() => fetchLeagueFixtures(league));
      const fixtures = (result as { fixtures: NormalizedFixture[] }).fixtures;
      succeeded = true;
      for (const fixture of fixtures) await saveApiFixture(fixture);
      records += fixtures.length;
    } catch (error) {
      const safe = apiFootballError(error);
      logger.warn(
        { provider: "api-football", statusCode: safe.statusCode, league: league.code },
        "Fixture collection failed",
      );
      errors.push(safe.message);
      if (safe.statusCode === 429) break;
    }
  }
  return { records, errors, succeeded };
}

async function saveMatchStats(
  matchId: number,
  stats: Awaited<ReturnType<typeof fetchMatchStatistics>>["stats"],
): Promise<void> {
  await db
    .insert(matchStatsTable)
    .values({ matchId, ...stats, source: "api-football", updatedAt: new Date() })
    .onConflictDoUpdate({
      target: matchStatsTable.matchId,
      set: { ...stats, source: "api-football", updatedAt: new Date() },
    });
}

async function syncRecentStats(): Promise<TaskResult> {
  const errors: string[] = [];
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentFinished = await db
    .select({ match: matchesTable, statsMatchId: matchStatsTable.matchId })
    .from(matchesTable)
    .leftJoin(matchStatsTable, eq(matchesTable.id, matchStatsTable.matchId))
    .where(
      and(
        eq(matchesTable.status, "finished"),
        gte(matchesTable.kickoff, cutoff),
        isNull(matchStatsTable.matchId),
      ),
    );

  let records = 0;
  let processed = 0;
  let succeeded = false;
  for (const row of recentFinished) {
    if (processed >= 8) break;
    const fixtureId = row.match.apiFootballFixtureId;
    if (fixtureId == null) continue;
    try {
      const statsResult = await callApiFootball(() => fetchMatchStatistics(fixtureId));
      succeeded = true;
      const stats = (statsResult as Awaited<ReturnType<typeof fetchMatchStatistics>>).stats;
      await saveMatchStats(row.match.id, stats);
      records += 1;
      processed += 1;

      try {
        const playersResult = await callApiFootball(() => fetchPlayerStatistics(fixtureId));
        succeeded = true;
        const players = (playersResult as Awaited<ReturnType<typeof fetchPlayerStatistics>>).players;
        for (const player of players) {
          await db
            .insert(playerMatchStatsTable)
            .values({
              matchId: row.match.id,
              ...player,
              source: "api-football",
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [playerMatchStatsTable.matchId, playerMatchStatsTable.playerApiId],
              set: { ...player, source: "api-football", updatedAt: new Date() },
            });
        }
        records += players.length;
      } catch (error) {
        errors.push(apiFootballError(error).message);
      }
    } catch (error) {
      const safe = apiFootballError(error);
      errors.push(safe.message);
      if (safe.statusCode === 429 || safe.message.includes("límite local")) break;
    }
  }
  return { records, errors, succeeded };
}

async function loadOrDiscoverTournaments(): Promise<{
  tournaments: TournamentRef[];
  error?: string;
}> {
  const current = await db
    .select()
    .from(providerTournamentsTable)
    .where(eq(providerTournamentsTable.provider, "oddspapi"));
  const stale =
    current.length < apiFootballLeagues.length ||
    current.some((item) => Date.now() - item.lastCheckedAt.getTime() > 7 * 24 * 60 * 60 * 1000);
  if (!stale) {
    return {
      tournaments: current.map((item) => ({
        leagueCode: item.leagueCode as LeagueCode,
        tournamentId: item.upstreamTournamentId,
        tournamentName: item.tournamentName,
      })),
    };
  }

  try {
    const result = await callOddsPapi(fetchFootballTournaments);
    const tournaments = (result as Awaited<ReturnType<typeof fetchFootballTournaments>>).tournaments;
    for (const tournament of tournaments) {
      await db
        .insert(providerTournamentsTable)
        .values({
          provider: "oddspapi",
          leagueCode: tournament.leagueCode,
          upstreamTournamentId: tournament.tournamentId,
          tournamentName: tournament.tournamentName,
          lastCheckedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            providerTournamentsTable.provider,
            providerTournamentsTable.leagueCode,
          ],
          set: {
            upstreamTournamentId: tournament.tournamentId,
            tournamentName: tournament.tournamentName,
            lastCheckedAt: new Date(),
          },
        });
    }
    return { tournaments };
  } catch (error) {
    return { tournaments: [], error: shortError(error, "oddspapi") };
  }
}

function quoteFingerprint(
  matchId: number,
  event: NormalizedOddsEvent,
  quote: NormalizedOddsEvent["quotes"][number],
): string {
  return createHash("sha256")
    .update(
      [
        matchId,
        quote.bookmaker,
        quote.marketName,
        quote.selection,
        quote.playerName ?? "",
        quote.line ?? "",
        quote.decimalOdds,
        quote.sourceUpdatedAt?.toISOString() ?? "",
      ].join("|"),
    )
    .digest("hex");
}

async function persistOddsEvent(event: NormalizedOddsEvent): Promise<number> {
  const matchId = await saveOddsMatch(event);
  for (const quote of event.quotes) {
    await db
      .insert(oddsQuotesTable)
      .values({
        matchId,
        provider: "oddspapi",
        upstreamBookmakerId: quote.upstreamBookmakerId,
        bookmaker: quote.bookmaker,
        upstreamMarketId: quote.upstreamMarketId,
        marketCategory: quote.marketCategory,
        marketName: quote.marketName,
        selection: quote.selection,
        playerName: quote.playerName,
        line: quote.line,
        decimalOdds: quote.decimalOdds,
        sourceUpdatedAt: quote.sourceUpdatedAt,
        capturedAt: new Date(),
        fingerprint: quoteFingerprint(matchId, event, quote),
      })
      .onConflictDoUpdate({
        target: oddsQuotesTable.fingerprint,
        set: { capturedAt: new Date(), decimalOdds: quote.decimalOdds },
      });
  }
  return event.quotes.length;
}

async function loadOddsReferenceData(): Promise<NonNullable<typeof oddsReferenceCache>> {
  if (
    oddsReferenceCache &&
    Date.now() - oddsReferenceCache.loadedAt < ODDSPAPI_REFERENCE_CACHE_MS
  ) return oddsReferenceCache;

  const bookmakerResult = await callOddsPapi(fetchFootballBookmakers);
  const participantResult = await callOddsPapi(fetchFootballParticipants);
  const marketResult = await callOddsPapi(fetchFootballMarkets);
  const bookmakers = (bookmakerResult as Awaited<ReturnType<typeof fetchFootballBookmakers>>).bookmakers;
  const participants = (participantResult as Awaited<ReturnType<typeof fetchFootballParticipants>>).participants;
  const markets = (marketResult as Awaited<ReturnType<typeof fetchFootballMarkets>>).markets;
  if (!bookmakers.length || !markets.length) {
    throw new Error("OddsPapi devolvió catálogos vacíos de casas o mercados.");
  }
  oddsReferenceCache = {
    loadedAt: Date.now(),
    bookmakers,
    participants,
    markets,
  };
  return oddsReferenceCache;
}

async function syncOdds(): Promise<TaskResult> {
  const errors: string[] = [];
  let records = 0;
  let succeeded = false;
  const result = await loadOrDiscoverTournaments();
  if (result.error) errors.push(result.error);
  if (!result.tournaments.length) return { records, errors, succeeded };

  const selectedLeagues = new Set(apiFootballLeagues.map((item) => item.code));
  const tournaments = result.tournaments.filter((item) =>
    selectedLeagues.has(item.leagueCode),
  );
  if (tournaments.length < apiFootballLeagues.length) {
    errors.push("OddsPapi no informó cobertura para todas las competiciones elegidas.");
  }

  let referenceData: NonNullable<typeof oddsReferenceCache>;
  try {
    referenceData = await loadOddsReferenceData();
  } catch (error) {
    return {
      records,
      errors: [...errors, shortError(error, "oddspapi")],
      succeeded,
    };
  }

  const requestedLabels = new Map([
    ["betplay", "BetPlay"],
    ["betano", "Betano"],
  ]);
  const normalizeBookmaker = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const selectedBookmakers = [...requestedLabels.keys()].flatMap((label) => {
    const bySlug = referenceData.bookmakers.find(
      (bookmaker) => normalizeBookmaker(bookmaker.slug) === label,
    );
    const match =
      bySlug ??
      referenceData.bookmakers.find(
        (bookmaker) => normalizeBookmaker(bookmaker.name) === label,
      );
    return match ? [match] : [];
  });
  const availableBookmakerLabels = new Set(
    referenceData.bookmakers.flatMap((bookmaker) => [
      normalizeBookmaker(bookmaker.slug),
      normalizeBookmaker(bookmaker.name),
    ]),
  );
  const missingBookmakers = [...requestedLabels.entries()]
    .filter(([slug]) => !availableBookmakerLabels.has(slug))
    .map(([, label]) => label);
  if (missingBookmakers.length) {
    errors.push(
      `OddsPapi no tiene disponible ${missingBookmakers.join(" ni ")} para esta cuenta.`,
    );
  }
  if (!selectedBookmakers.length) {
    return { records, errors, succeeded: true };
  }

  const eventsByIdentity = new Map<string, NormalizedOddsEvent>();
  logger.info(
    {
      provider: "oddspapi",
      tournaments: tournaments.map(({ leagueCode, tournamentId }) => ({
        leagueCode,
        tournamentId,
      })),
      bookmakerSlugs: selectedBookmakers.map((bookmaker) => bookmaker.slug),
    },
    "Requesting tournament odds",
  );
  for (const bookmaker of selectedBookmakers) {
    try {
      const response = await callOddsPapi(() =>
        fetchTournamentOdds(
          tournaments,
          bookmaker,
          referenceData.participants,
          referenceData.markets,
        ),
      );
      succeeded = true;
      const bookmakerEvents =
        (response as Awaited<ReturnType<typeof fetchTournamentOdds>>).events;
      logger.info(
        {
          provider: "oddspapi",
          bookmakerSlug: bookmaker.slug,
          eventCount: bookmakerEvents.length,
          quoteCount: bookmakerEvents.reduce(
            (total, event) => total + event.quotes.length,
            0,
          ),
        },
        "Odds provider response parsed",
      );
      for (const event of bookmakerEvents) {
        const identity = event.oddsPapiFixtureId ?? [
          event.leagueCode,
          normalizeTeam(event.homeTeam),
          normalizeTeam(event.awayTeam),
          event.kickoff.toISOString(),
        ].join("|");
        const existing = eventsByIdentity.get(identity);
        if (existing) {
          existing.quotes.push(...event.quotes);
        } else {
          eventsByIdentity.set(identity, { ...event, quotes: [...event.quotes] });
        }
      }
    } catch (error) {
      errors.push(shortError(error, "oddspapi"));
      const statusCode =
        typeof error === "object" && error != null && "statusCode" in error
          ? Number((error as { statusCode?: unknown }).statusCode)
          : undefined;
      logger.warn(
        { provider: "oddspapi", bookmakerSlug: bookmaker.slug, statusCode },
        "Odds collection failed",
      );
    }
  }
  const events = [...eventsByIdentity.values()];
  const quoteCount = events.reduce((total, event) => total + event.quotes.length, 0);
  logger.info(
    {
      provider: "oddspapi",
      tournamentCount: tournaments.length,
      eventCount: events.length,
      quoteCount,
      shotOnTargetQuotes: events.reduce(
        (total, event) =>
          total +
          event.quotes.filter((quote) => quote.marketCategory === "shots-on-target").length,
        0,
      ),
    },
    "Odds collection merged",
  );
  if (succeeded && !events.length && !errors.length) {
    errors.push("OddsPapi no devolvió partidos para los torneos seleccionados.");
  } else if (succeeded && events.length && !quoteCount) {
    errors.push("OddsPapi devolvió partidos sin cuotas de los mercados reconocidos.");
  }
  for (const event of events) records += await persistOddsEvent(event);
  return { records, errors, succeeded };
}

async function runProviderTask(
  provider: ProviderName,
  name: string,
  action: () => Promise<TaskResult>,
): Promise<void> {
  await ensureSourceRow(provider);
  if (!providerKeys[provider]) {
    await updateSource(provider, {
      state: "unconfigured",
      lastAttemptAt: new Date(),
      message: "Falta la credencial de este proveedor.",
      recordsCollected: 0,
    });
    return;
  }
  await updateSource(provider, {
    state: "waiting",
    lastAttemptAt: new Date(),
    message: `Sincronización de ${name} en curso.`,
  });
  try {
    const result = await action();
    const state = result.errors.length
      ? result.succeeded
        ? "partial"
        : "error"
      : result.succeeded
        ? "ok"
        : "waiting";
    const statusUpdate: Partial<typeof sourceStatusTable.$inferInsert> = {
      state,
      recordsCollected: result.records,
      message: result.errors.length
        ? `${result.records} registros recibidos; ${result.errors[0]}`
        : result.succeeded
          ? `${result.records} registros recibidos en la última sincronización.`
          : "No había datos pendientes que actualizar.",
    };
    if (result.succeeded) statusUpdate.lastSuccessAt = new Date();
    await updateSource(provider, statusUpdate);
  } catch (error) {
    const message = shortError(error, provider);
    await updateSource(provider, {
      state: message.includes("no está configurado") ? "unconfigured" : "error",
      message,
    });
    logger.warn(
      { provider, operation: name, detail: describeError(error, [process.env.API_FOOTBALL_KEY, process.env.ODDSPAPI_API_KEY]) },
      "Data provider task failed",
    );
  }
}

async function runSync(options: SyncOptions): Promise<void> {
  const useApiFootball = options.providers.includes("api-football");
  const useOddsPapi = options.providers.includes("oddspapi");
  const wantFixtures = options.scope === "all" || options.scope === "fixtures";
  const wantStats = options.scope === "all" || options.scope === "stats";
  const wantOdds = options.scope === "all" || options.scope === "odds";

  if (useApiFootball && (wantFixtures || wantStats)) {
    await runProviderTask(
      "api-football",
      wantFixtures && wantStats ? "fixtures y estadísticas" : wantFixtures ? "fixtures" : "estadísticas",
      async () => {
        let records = 0;
        const errors: string[] = [];
        let succeeded = false;
        if (wantFixtures) {
          const fixtures = await syncFixtures();
          records += fixtures.records;
          errors.push(...fixtures.errors);
          succeeded ||= fixtures.succeeded;
          lastFixtureRunAt = Date.now();
        }
        if (wantStats) {
          const stats = await syncRecentStats();
          records += stats.records;
          errors.push(...stats.errors);
          succeeded ||= stats.succeeded;
          lastStatsRunAt = Date.now();
        }
        return { records, errors, succeeded };
      },
    );
  }
  if (wantFixtures || wantStats) {
    // Historial gratuito (football-data.co.uk): no depende del plan de API-Football.
    const history = await importFootballData({ force: !options.scheduled });
    if (history.errors.length) logger.warn({ errors: history.errors }, "football-data import had errors");
  }
  if (useOddsPapi && wantOdds) {
    await runProviderTask("oddspapi", "cuotas", async () => {
      const odds = await syncOdds();
      lastOddsRunAt = Date.now();
      return odds;
    });
  }
  try {
    await refreshModelPredictions();
  } catch {
    logger.warn("Model predictions could not be refreshed");
  }
}

function startRun(options: SyncOptions): boolean {
  if (activeRun) return false;
  activeRun = runSync(options)
    .catch((error: unknown) => {
      logger.error({ error: shortError(error) }, "Data sync failed unexpectedly");
    })
    .finally(() => {
      activeRun = null;
    });
  return true;
}

export function requestImmediateSync(input: {
  scope: SyncScope;
  providers?: ProviderName[];
}): { accepted: boolean; queuedAt: Date; message: string; retryAfterSeconds?: number } {
  const now = Date.now();
  const providers: ProviderName[] = input.providers?.length
    ? input.providers
    : ["api-football", "oddspapi"];
  if (activeRun) {
    return {
      accepted: true,
      queuedAt: new Date(),
      message: "Ya hay una sincronización activa; no se inició otra.",
    };
  }
  if (now - lastManualRunAt < MANUAL_COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil(
      (MANUAL_COOLDOWN_MS - (now - lastManualRunAt)) / 1000,
    );
    return {
      accepted: false,
      queuedAt: new Date(),
      message: "La sincronización manual está temporalmente limitada.",
      retryAfterSeconds,
    };
  }
  const accepted = startRun({ scope: input.scope, providers });
  if (!accepted) {
    return {
      accepted: true,
      queuedAt: new Date(),
      message: "Ya hay una sincronización activa; no se inició otra.",
    };
  }
  lastManualRunAt = now;
  return {
    accepted: true,
    queuedAt: new Date(),
    message: "Sincronización iniciada. El estado y los datos se actualizarán al terminar.",
  };
}

export function getNextScheduledSyncAt(): Date {
  const now = Date.now();
  const candidates = [
    lastFixtureRunAt + FIXTURE_INTERVAL_MS,
    lastStatsRunAt + FIXTURE_INTERVAL_MS,
    lastOddsRunAt + ODDS_INTERVAL_MS,
  ].filter((value) => value > now);
  nextScheduledAt = new Date(candidates.length ? Math.min(...candidates) : now + 60_000);
  return nextScheduledAt;
}

export const syncScheduleDescription =
  "Fixtures y estadísticas cada 6 h (máximo 80 llamadas locales/día); cuotas cada 8 h (máximo 200 llamadas locales/mes).";

export function startCollector(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  for (const provider of ["api-football", "oddspapi"] as const) {
    void ensureSourceRow(provider).catch(() => {
      logger.warn({ provider }, "Could not initialize provider status");
    });
  }
  const initialTimer = setTimeout(() => {
    const providers: ProviderName[] = ["api-football", "oddspapi"];
    if (startRun({ scope: "all", providers, scheduled: true })) {
      lastFixtureRunAt = Date.now();
      lastStatsRunAt = Date.now();
      lastOddsRunAt = Date.now();
    }
  }, 15_000);
  initialTimer.unref?.();

  const scheduler = setInterval(() => {
    if (activeRun) return;
    const now = Date.now();
    if (
      now - lastFixtureRunAt >= FIXTURE_INTERVAL_MS ||
      now - lastStatsRunAt >= FIXTURE_INTERVAL_MS
    ) {
      if (startRun({ scope: "all", providers: ["api-football"], scheduled: true })) {
        lastFixtureRunAt = now;
        lastStatsRunAt = now;
      }
      return;
    }
    if (now - lastOddsRunAt >= ODDS_INTERVAL_MS) {
      if (startRun({ scope: "odds", providers: ["oddspapi"], scheduled: true })) {
        lastOddsRunAt = now;
      }
      return;
    }
    nextScheduledAt = getNextScheduledSyncAt();
  }, 60_000);
  scheduler.unref?.();
}

export async function getProviderStatusRows() {
  await Promise.all([
    ensureSourceRow("api-football"),
    ensureSourceRow("oddspapi"),
  ]);
  const rows = await db.select().from(sourceStatusTable);
  return rows.map((row) => {
    const provider = row.provider as ProviderName;
    const period = providerPeriod(provider);
    const used =
      periodKey(row.quotaPeriodStart) === periodKey(period) ? row.requestsUsed : 0;
    const limit = row.requestLimit;
    const remaining =
      row.requestsRemaining ??
      (limit == null ? null : Math.max(0, limit - used));
    return {
      provider,
      state: !providerKeys[provider] ? "unconfigured" : row.state,
      lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      recordsCollected: row.recordsCollected,
      requestsRemaining: remaining,
      requestLimit: limit,
      message:
        row.message ??
        (!providerKeys[provider] ? "Falta la credencial de este proveedor." : null),
    };
  });
}