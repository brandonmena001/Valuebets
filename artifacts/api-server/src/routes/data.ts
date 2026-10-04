import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lte,
  max,
  or,
} from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  matchesTable,
  matchStatsTable,
  modelPredictionsTable,
  oddsQuotesTable,
  sourceStatusTable,
} from "@workspace/db";
import {
  ErrorResponse,
  GetDashboardSummaryResponse,
  GetMatchDetailParams,
  GetMatchDetailResponse,
  GetMatchesQueryParams,
  GetMatchesResponse,
  GetSourceStatusResponse,
  GetValueBetsQueryParams,
  GetValueBetsResponse,
  RequestDataSyncBody,
  RequestDataSyncResponse,
} from "@workspace/api-zod";
import {
  getNextScheduledSyncAt,
  getProviderStatusRows,
  requestImmediateSync,
  syncScheduleDescription,
  type ProviderName,
  type SyncScope,
} from "../services/collector";
import { buildMatchSnapshot } from "../model/predict";
import { loadFinishedHistory } from "../services/value-model";

const router: IRouter = Router();

function sendApiError(
  res: import("express").Response,
  status: number,
  error: string,
): void {
  const body: ErrorResponse = { error };
  res.status(status).json(body);
}

type MarketCategory =
  | "match-result"
  | "goals"
  | "corners"
  | "cards"
  | "shots-on-target";

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function fixtureKey(match: typeof matchesTable.$inferSelect): string {
  return String(match.apiFootballFixtureId ?? match.oddsPapiFixtureId ?? match.id);
}

function safeMatchStatus(
  status: string,
): "scheduled" | "live" | "finished" | "postponed" | "cancelled" | "unknown" {
  if (
    status === "scheduled" ||
    status === "live" ||
    status === "finished" ||
    status === "postponed" ||
    status === "cancelled"
  ) return status;
  return "unknown";
}

function outputOdds(
  quote: typeof oddsQuotesTable.$inferSelect,
): {
  id: string;
  category: MarketCategory;
  marketName: string;
  selection: string;
  playerName: string | null;
  line: number | null;
  bookmaker: string;
  decimalOdds: number;
  source: "api-football" | "oddspapi";
  sourceUpdatedAt: string | null;
  capturedAt: string;
} {
  return {
    id: String(quote.id),
    category: quote.marketCategory as MarketCategory,
    marketName: quote.marketName,
    selection: quote.selection,
    playerName: quote.playerName,
    line: quote.line,
    bookmaker: quote.bookmaker,
    decimalOdds: quote.decimalOdds,
    source: quote.provider as "api-football" | "oddspapi",
    sourceUpdatedAt: iso(quote.sourceUpdatedAt),
    capturedAt: quote.capturedAt.toISOString(),
  };
}

async function loadValueBets(filters: {
  league?: string;
  marketCategory?: string;
  minEv: number;
  limit?: number;
}) {
  const conditions = [
    gt(matchesTable.kickoff, new Date()),
    gt(modelPredictionsTable.expectedValuePct, filters.minEv),
    gte(oddsQuotesTable.capturedAt, new Date(Date.now() - 12 * 60 * 60 * 1000)),
  ];
  if (filters.league) conditions.push(eq(matchesTable.leagueCode, filters.league));
  if (filters.marketCategory) {
    conditions.push(eq(oddsQuotesTable.marketCategory, filters.marketCategory));
  }

  const rows = await db
    .select({
      quote: oddsQuotesTable,
      prediction: modelPredictionsTable,
      match: matchesTable,
    })
    .from(modelPredictionsTable)
    .innerJoin(oddsQuotesTable, eq(modelPredictionsTable.oddsQuoteId, oddsQuotesTable.id))
    .innerJoin(matchesTable, eq(oddsQuotesTable.matchId, matchesTable.id))
    .where(and(...conditions))
    .orderBy(desc(modelPredictionsTable.expectedValuePct))
    .limit(filters.limit ?? 2_000);

  return rows.map(({ quote, prediction, match }) => ({
    ...outputOdds(quote),
    fixtureId: fixtureKey(match),
    league: match.leagueCode as "premier-league" | "la-liga" | "bundesliga",
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    kickoff: match.kickoff.toISOString(),
    modelProbability: prediction.modelProbability,
    fairOdds: prediction.fairOdds,
    expectedValuePct: prediction.expectedValuePct,
    modelVersion: prediction.modelVersion,
    sampleSize: prediction.sampleSize,
    confidence: prediction.confidence as "low" | "medium" | "high",
    marketProbability: prediction.marketProbability,
    kellyFraction: prediction.kellyFraction,
    bookmakersCount: prediction.bookmakersCount,
  }));
}

async function loadDashboardSummary() {
  const now = new Date();
  const upcoming = await db
    .select({ id: matchesTable.id })
    .from(matchesTable)
    .where(
      and(
        gte(matchesTable.kickoff, now),
        eq(matchesTable.status, "scheduled"),
      ),
    );
  const live = await db
    .select({ id: matchesTable.id })
    .from(matchesTable)
    .where(eq(matchesTable.status, "live"));
  const sources = await db.select().from(sourceStatusTable);
  const bets = await loadValueBets({ minEv: 0, limit: 2_000 });
  const oddsSource = sources.find((item) => item.provider === "oddspapi");
  const statsSource = sources.find((item) => item.provider === "api-football");
  const states = sources.map((item) => item.state);
  let dataState:
    | "unconfigured"
    | "waiting"
    | "ok"
    | "partial"
    | "stale"
    | "error" = "waiting";
  if (states.length && states.every((state) => state === "unconfigured")) {
    dataState = "unconfigured";
  } else if (states.includes("error")) {
    dataState = "error";
  } else if (states.includes("stale")) {
    dataState = "stale";
  } else if (states.includes("partial") || states.includes("unconfigured")) {
    dataState = "partial";
  } else if (states.length && states.every((state) => state === "ok")) {
    dataState = "ok";
  }

  return GetDashboardSummaryResponse.parse({
    generatedAt: now.toISOString(),
    upcomingMatches: upcoming.length,
    liveMatches: live.length,
    valueBetsCount: bets.length,
    averageEvPct: bets.length
      ? bets.reduce((total, bet) => total + bet.expectedValuePct, 0) / bets.length
      : null,
    latestOddsSync: iso(oddsSource?.lastSuccessAt),
    latestStatsSync: iso(statsSource?.lastSuccessAt),
    dataState,
    topValueBets: bets.slice(0, 5),
  });
}

router.get("/dashboard", async (req, res): Promise<void> => {
  req.log.info("Loading dashboard summary");
  res.json(await loadDashboardSummary());
});

router.get("/value-bets", async (req, res): Promise<void> => {
  const parsed = GetValueBetsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    sendApiError(res, 400, parsed.error.message);
    return;
  }
  const bets = await loadValueBets({
    league: parsed.data.league,
    marketCategory: parsed.data.marketCategory,
    minEv: parsed.data.minEv,
  });
  res.json(GetValueBetsResponse.parse(bets));
});

router.get("/matches", async (req, res): Promise<void> => {
  const parsed = GetMatchesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    sendApiError(res, 400, parsed.error.message);
    return;
  }
  const now = new Date();
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + parsed.data.days * 24 * 60 * 60 * 1000);
  const conditions = [gte(matchesTable.kickoff, start), lte(matchesTable.kickoff, end)];
  if (parsed.data.league) {
    conditions.push(eq(matchesTable.leagueCode, parsed.data.league));
  }
  if (parsed.data.status) {
    conditions.push(eq(matchesTable.status, parsed.data.status));
  }
  const rows = await db
    .select({ match: matchesTable, stats: matchStatsTable })
    .from(matchesTable)
    .leftJoin(matchStatsTable, eq(matchesTable.id, matchStatsTable.matchId))
    .where(and(...conditions))
    .orderBy(matchesTable.kickoff)
    .limit(500);
  const matchIds = rows.map(({ match }) => match.id);
  const marketRows = matchIds.length
    ? await db
        .select({
          matchId: oddsQuotesTable.matchId,
          category: oddsQuotesTable.marketCategory,
        })
        .from(oddsQuotesTable)
        .where(inArray(oddsQuotesTable.matchId, matchIds))
        .groupBy(oddsQuotesTable.matchId, oddsQuotesTable.marketCategory)
    : [];
  const lastQuoteRows = matchIds.length
    ? await db
        .select({
          matchId: oddsQuotesTable.matchId,
          capturedAt: max(oddsQuotesTable.capturedAt),
        })
        .from(oddsQuotesTable)
        .where(inArray(oddsQuotesTable.matchId, matchIds))
        .groupBy(oddsQuotesTable.matchId)
    : [];
  const marketMap = new Map<number, MarketCategory[]>();
  for (const row of marketRows) {
    const market = row.category as MarketCategory;
    const categories = marketMap.get(row.matchId) ?? [];
    if (!categories.includes(market)) categories.push(market);
    marketMap.set(row.matchId, categories);
  }
  const quoteTimeMap = new Map(
    lastQuoteRows.map((row) => [row.matchId, row.capturedAt]),
  );
  const matches = rows.map(({ match, stats }) => {
    const latest = [match.updatedAt, stats?.updatedAt, quoteTimeMap.get(match.id)]
      .filter((value): value is Date => value instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    return {
      fixtureId: fixtureKey(match),
      league: match.leagueCode,
      country: match.country,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      kickoff: match.kickoff.toISOString(),
      status: safeMatchStatus(match.status),
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      stats: {
        homeCorners: stats?.homeCorners ?? null,
        awayCorners: stats?.awayCorners ?? null,
        homeYellowCards: stats?.homeYellowCards ?? null,
        awayYellowCards: stats?.awayYellowCards ?? null,
        homeRedCards: stats?.homeRedCards ?? null,
        awayRedCards: stats?.awayRedCards ?? null,
        homeShotsOnTarget: stats?.homeShotsOnTarget ?? null,
        awayShotsOnTarget: stats?.awayShotsOnTarget ?? null,
      },
      availableMarkets: marketMap.get(match.id) ?? [],
      lastUpdatedAt: iso(latest),
    };
  });
  res.json(GetMatchesResponse.parse(matches));
});

router.get("/matches/:fixtureId", async (req, res): Promise<void> => {
  const parsed = GetMatchDetailParams.safeParse(req.params);
  if (!parsed.success) {
    sendApiError(res, 400, parsed.error.message);
    return;
  }
  const key = parsed.data.fixtureId;
  const numericKey = Number(key);
  const conditions = [eq(matchesTable.oddsPapiFixtureId, key)];
  if (Number.isInteger(numericKey) && numericKey > 0) {
    conditions.push(eq(matchesTable.apiFootballFixtureId, numericKey));
    conditions.push(eq(matchesTable.id, numericKey));
  }
  const [row] = await db
    .select({ match: matchesTable, stats: matchStatsTable })
    .from(matchesTable)
    .leftJoin(matchStatsTable, eq(matchesTable.id, matchStatsTable.matchId))
    .where(or(...conditions))
    .limit(1);
  if (!row) {
    sendApiError(res, 404, "Partido no encontrado.");
    return;
  }
  const quoteRows = await db
    .select()
    .from(oddsQuotesTable)
    .where(eq(oddsQuotesTable.matchId, row.match.id))
    .orderBy(desc(oddsQuotesTable.capturedAt))
    .limit(500);
  const latestQuote = quoteRows[0]?.capturedAt ?? null;
  const latest =
    [row.match.updatedAt, row.stats?.updatedAt, latestQuote]
      .filter((value): value is Date => value instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const model =
    row.match.status === "scheduled"
      ? buildMatchSnapshot({ history: await loadFinishedHistory(new Date()), match: row.match, now: new Date() })
      : null;
  res.json(
    GetMatchDetailResponse.parse({
      model,
      match: {
        fixtureId: fixtureKey(row.match),
        league: row.match.leagueCode,
        country: row.match.country,
        homeTeam: row.match.homeTeam,
        awayTeam: row.match.awayTeam,
        kickoff: row.match.kickoff.toISOString(),
        status: safeMatchStatus(row.match.status),
        homeScore: row.match.homeScore,
        awayScore: row.match.awayScore,
        stats: {
          homeCorners: row.stats?.homeCorners ?? null,
          awayCorners: row.stats?.awayCorners ?? null,
          homeYellowCards: row.stats?.homeYellowCards ?? null,
          awayYellowCards: row.stats?.awayYellowCards ?? null,
          homeRedCards: row.stats?.homeRedCards ?? null,
          awayRedCards: row.stats?.awayRedCards ?? null,
          homeShotsOnTarget: row.stats?.homeShotsOnTarget ?? null,
          awayShotsOnTarget: row.stats?.awayShotsOnTarget ?? null,
        },
        availableMarkets: [
          ...new Set(quoteRows.map((quote) => quote.marketCategory)),
        ],
        lastUpdatedAt: iso(latest),
      },
      odds: quoteRows.map(outputOdds),
    }),
  );
});

router.get("/sources", async (_req, res): Promise<void> => {
  const sources = await getProviderStatusRows();
  res.json(
    GetSourceStatusResponse.parse({
      sources,
      nextScheduledSyncAt: getNextScheduledSyncAt().toISOString(),
      scheduleDescription: syncScheduleDescription,
    }),
  );
});

router.post("/sync", async (req, res): Promise<void> => {
  const parsed = RequestDataSyncBody.safeParse(req.body);
  if (!parsed.success) {
    sendApiError(res, 400, parsed.error.message);
    return;
  }
  const result = requestImmediateSync({
    scope: parsed.data.scope as SyncScope,
    providers: parsed.data.providers as ProviderName[] | undefined,
  });
  if (!result.accepted) {
    sendApiError(res, 429, result.message);
    return;
  }
  res.status(202).json(
    RequestDataSyncResponse.parse({
      accepted: result.accepted,
      queuedAt: result.queuedAt.toISOString(),
      message: result.message,
    }),
  );
});

export default router;