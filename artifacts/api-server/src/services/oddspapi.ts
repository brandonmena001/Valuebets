import type { LeagueCode } from "./api-football";
import { ProviderError } from "./api-football";

export type TournamentRef = {
  leagueCode: LeagueCode;
  tournamentId: string;
  tournamentName: string;
};

export type NormalizedOddsQuote = {
  marketCategory: "match-result" | "goals" | "corners" | "cards" | "shots-on-target";
  marketName: string;
  selection: string;
  playerName: string | null;
  line: number | null;
  bookmaker: string;
  upstreamBookmakerId: string | null;
  upstreamMarketId: string | null;
  decimalOdds: number;
  sourceUpdatedAt: Date | null;
};

export type NormalizedOddsEvent = {
  oddsPapiFixtureId: string | null;
  leagueCode: LeagueCode;
  homeTeam: string;
  awayTeam: string;
  kickoff: Date;
  status: "scheduled" | "live" | "finished" | "cancelled" | "unknown";
  quotes: NormalizedOddsQuote[];
};

export type OddsPapiQuota = {
  requestsRemaining: number | null;
  requestLimit: number | null;
};

export type OddsPapiBookmaker = {
  slug: string;
  name: string;
};

export type OddsPapiMarket = {
  id: string;
  name: string;
  playerProp: boolean;
  handicap: number | null;
  outcomeNames: Record<string, string>;
};

let lastRequestStartedAt = 0;

function apiKey(): string {
  const key = process.env.ODDSPAPI_API_KEY;
  if (!key) throw new ProviderError("OddsPapi no está configurado.");
  return key;
}

async function oddsPapiGet(
  path: string,
  params: Record<string, string>,
): Promise<{ body: unknown; quota: OddsPapiQuota }> {
  const waitMs = Math.max(0, 1_000 - (Date.now() - lastRequestStartedAt));
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastRequestStartedAt = Date.now();
  const query = new URLSearchParams({ ...params, apiKey: apiKey() });
  const response = await fetch(`https://api.oddspapi.io${path}?${query}`, {
    signal: AbortSignal.timeout(25_000),
  });
  const quota = {
    requestsRemaining: readHeader(response.headers.get("x-ratelimit-remaining")),
    requestLimit: readHeader(response.headers.get("x-ratelimit-limit")),
  };
  const responseText = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(responseText) as unknown;
  } catch {
    body = responseText || null;
  }
  if (!response.ok) {
    const detail = safeProviderErrorDetail(body, apiKey());
    throw new ProviderError(
      `OddsPapi respondió HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
      response.status,
    );
  }
  return { body, quota };
}

function readHeader(value: string | null): number | null {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function findText(object: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) return text;
    }
    const nested = record(value);
    if (nested) {
      const name = findText(nested, ["name", "fullName", "label", "title"]);
      if (name) return name;
    }
  }
  return null;
}

function findNumber(object: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const number = Number(value.replace(",", "."));
      if (Number.isFinite(number)) return number;
    }
  }
  return null;
}

function safeProviderErrorDetail(body: unknown, secret: string): string {
  const safeMessageKeys = new Set([
    "message",
    "error",
    "detail",
    "details",
    "description",
    "reason",
    "errormessage",
    "error_description",
    "code",
  ]);
  const messages: string[] = [];
  const collect = (value: unknown, depth = 0): void => {
    if (depth > 5) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 5)) collect(item, depth + 1);
      return;
    }
    const object = record(value);
    if (!object) return;
    for (const [key, nested] of Object.entries(object)) {
      const normalizedKey = key.toLowerCase();
      if (/(key|token|secret|authorization|credential)/i.test(normalizedKey)) continue;
      if (safeMessageKeys.has(normalizedKey) && typeof nested === "string") {
        messages.push(`${key}: ${nested}`);
      } else if (typeof nested === "object" && nested != null) {
        collect(nested, depth + 1);
      }
    }
  };
  collect(body);
  const object = record(body);
  const raw =
    typeof body === "string"
      ? body
      : messages.length
        ? messages.join("; ")
        : object
          ? `Respuesta del proveedor con campos: ${Object.keys(object).slice(0, 5).join(", ")}`
          : "";
  return raw
    .split(secret)
    .join("[credencial]")
    .replace(/([?&](?:apiKey|token)=)[^&\s]+/gi, "$1[redactado]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[correo]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redactado]")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function leagueForName(name: string): LeagueCode | null {
  const normalized = name.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  if (
    normalized.includes("premier league") &&
    !/women|u\d|under|2nd|reserve|academy/.test(normalized)
  ) return "premier-league";
  if (
    (normalized.includes("la liga") ||
      normalized.includes("laliga") ||
      normalized.includes("primera division")) &&
    !/women|u\d|under|2|reserve/.test(normalized)
  ) return "la-liga";
  if (
    normalized.includes("bundesliga") &&
    !/women|u\d|under|2\.|second|reserve/.test(normalized)
  ) return "bundesliga";
  return null;
}

function findTournamentRecords(root: unknown): TournamentRef[] {
  const found = new Map<LeagueCode, TournamentRef>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const object = record(value);
    if (!object) return;
    const name = findText(object, ["tournamentName", "name", "title", "competitionName"]);
    const id = findText(object, ["tournamentId", "tournament_id", "id", "key"]);
    const leagueCode = name ? leagueForName(name) : null;
    if (name && id && leagueCode && !found.has(leagueCode)) {
      found.set(leagueCode, { leagueCode, tournamentId: id, tournamentName: name });
    }
    for (const nested of Object.values(object)) visit(nested);
  };
  visit(root);
  return [...found.values()];
}

export async function fetchFootballTournaments(): Promise<{
  tournaments: TournamentRef[];
  quota: OddsPapiQuota;
}> {
  const { body, quota } = await oddsPapiGet("/v4/tournaments", { sportId: "10" });
  const tournaments = findTournamentRecords(body);
  if (!tournaments.length) {
    throw new ProviderError("OddsPapi no devolvió torneos reconocibles para las ligas elegidas.");
  }
  return { tournaments, quota };
}

export async function fetchFootballBookmakers(): Promise<{
  bookmakers: OddsPapiBookmaker[];
  quota: OddsPapiQuota;
}> {
  const { body, quota } = await oddsPapiGet("/v4/bookmakers", {});
  if (!Array.isArray(body)) {
    throw new ProviderError("OddsPapi devolvió un catálogo de casas con formato desconocido.");
  }
  const bookmakers = body.flatMap((item) => {
    const object = record(item);
    const slug = findText(object ?? {}, ["slug"]);
    const name = findText(object ?? {}, ["bookmakerName", "name"]);
    return slug && name ? [{ slug, name }] : [];
  });
  return { bookmakers, quota };
}

export async function fetchFootballParticipants(): Promise<{
  participants: Record<string, string>;
  quota: OddsPapiQuota;
}> {
  const { body, quota } = await oddsPapiGet("/v4/participants", {
    sportId: "10",
    language: "en",
  });
  const object = record(body);
  if (!object) {
    throw new ProviderError("OddsPapi devolvió un catálogo de equipos con formato desconocido.");
  }
  const participants = Object.fromEntries(
    Object.entries(object).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return { participants, quota };
}

export async function fetchFootballMarkets(): Promise<{
  markets: OddsPapiMarket[];
  quota: OddsPapiQuota;
}> {
  const { body, quota } = await oddsPapiGet("/v4/markets", {
    language: "en",
  });
  if (!Array.isArray(body)) {
    throw new ProviderError("OddsPapi devolvió un catálogo de mercados con formato desconocido.");
  }
  const markets = body.flatMap((item) => {
    const object = record(item);
    if (!object) return [];
    const id = findText(object, ["marketId"]);
    const name = findText(object, ["marketName"]);
    if (!id || !name) return [];
    const outcomes = Array.isArray(object.outcomes) ? object.outcomes : [];
    const outcomeNames = Object.fromEntries(
      outcomes.flatMap((item) => {
        const outcome = record(item);
        if (!outcome) return [];
        const outcomeId = findText(outcome, ["outcomeId"]);
        const outcomeName = findText(outcome, ["outcomeName"]);
        return outcomeId && outcomeName ? [[outcomeId, outcomeName]] : [];
      }),
    );
    return [{
      id,
      name,
      playerProp: object.playerProp === true,
      handicap: findNumber(object, ["handicap"]),
      outcomeNames,
    }];
  });
  return { markets, quota };
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function teamName(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const object = record(value);
  return object ? findText(object, ["name", "fullName", "teamName", "label"]) : null;
}

function eventDetails(
  object: Record<string, unknown>,
  participants: Record<string, string>,
): {
  home: string;
  away: string;
  kickoff: Date;
  id: string | null;
  status: NormalizedOddsEvent["status"];
} | null {
  const homeId = findText(object, ["participant1Id"]);
  const awayId = findText(object, ["participant2Id"]);
  const home =
    teamName(object.homeTeam) ??
    teamName(object.home) ??
    findText(object, ["participant1Name", "homeTeamName", "homeName"]) ??
    (homeId ? participants[homeId] : null);
  const away =
    teamName(object.awayTeam) ??
    teamName(object.away) ??
    findText(object, ["participant2Name", "awayTeamName", "awayName"]) ??
    (awayId ? participants[awayId] : null);
  const rawDate = findText(object, [
    "startTime",
    "start_time",
    "kickoff",
    "date",
    "eventDate",
    "fixtureDate",
  ]);
  if (!home || !away || !rawDate) return null;
  const kickoff = new Date(rawDate);
  if (Number.isNaN(kickoff.getTime())) return null;
  const id = findText(object, ["fixtureId", "eventId", "fixture_id", "event_id", "id"]);
  const statusId = findNumber(object, ["statusId"]);
  const statusName = findText(object, ["statusName"])?.toLowerCase() ?? "";
  const status =
    statusId === 0 || statusName.includes("pre-game") || statusName.includes("scheduled")
      ? "scheduled"
      : statusId === 1 || statusName.includes("live") || statusName.includes("in-play")
        ? "live"
        : statusId === 2 || statusName.includes("ended") || statusName.includes("finished")
          ? "finished"
          : statusId === 3 || statusName.includes("cancel")
            ? "cancelled"
            : "unknown";
  return { home, away, kickoff, id, status };
}

function classifyMarket(market: string): NormalizedOddsQuote["marketCategory"] | null {
  const normalized = market
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  if (/shot.*target|shots on target|shots on goal|disparos? a puerta|tiros? a puerta/.test(normalized)) {
    return "shots-on-target";
  }
  if (/corner|esquina/.test(normalized)) return "corners";
  if (/card|booking|tarjeta/.test(normalized)) return "cards";
  if (/goal|gol|total over|over\/under|over under/.test(normalized)) return "goals";
  if (/1x2|match result|match winner|full.?time result|three.?way|resultado.*partido|ganador/.test(normalized)) {
    return "match-result";
  }
  return null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function lineFromSelection(selection: string): number | null {
  const normalized = selection.replace(",", ".");
  const threshold = normalized.match(/^\s*(-?\d+(?:\.\d+)?)\s*\+\s*$/);
  const overUnder = normalized.match(
    /(?:over|under|more than|less than|above|below)\s*(-?\d+(?:\.\d+)?)/i,
  );
  const value = Number(threshold?.[1] ?? overUnder?.[1]);
  return Number.isFinite(value) ? value : null;
}

function extractQuotes(
  event: Record<string, unknown>,
  bookmakers: OddsPapiBookmaker[],
  markets: Map<string, OddsPapiMarket>,
): NormalizedOddsQuote[] {
  const quotes: NormalizedOddsQuote[] = [];
  const seen = new Set<string>();
  const bookmakerOdds = record(event.bookmakerOdds);
  if (!bookmakerOdds) return quotes;

  const bookmakerBySlug = new Map(
    bookmakers.map((bookmaker) => [normalizeName(bookmaker.slug), bookmaker]),
  );
  for (const [rawSlug, rawBookmaker] of Object.entries(bookmakerOdds)) {
    const bookmaker = bookmakerBySlug.get(normalizeName(rawSlug));
    const bookmakerObject = record(rawBookmaker);
    const marketObjects = record(bookmakerObject?.markets);
    if (!bookmaker || !bookmakerObject || !marketObjects || bookmakerObject.suspended === true) {
      continue;
    }

    for (const [marketId, rawMarket] of Object.entries(marketObjects)) {
      const market = markets.get(marketId);
      const marketObject = record(rawMarket);
      const category = market ? classifyMarket(market.name) : null;
      const outcomes = record(marketObject?.outcomes);
      if (
        !market ||
        !category ||
        !marketObject ||
        !outcomes ||
        marketObject.marketActive === false
      ) continue;

      for (const [outcomeId, rawOutcome] of Object.entries(outcomes)) {
        const outcome = record(rawOutcome);
        if (!outcome) continue;
        const selection = market.outcomeNames[outcomeId];
        if (!selection) continue;
        const players = record(outcome.players);
        const pricingRows = players
          ? Object.values(players)
          : [outcome];
        for (const rawPricing of pricingRows) {
          const pricing = record(rawPricing);
          if (!pricing || pricing.active === false) continue;
          const decimalOdds = findNumber(pricing, ["price"]);
          if (decimalOdds == null || decimalOdds <= 1) continue;
          const playerName = findText(pricing, ["playerName"]);
          if (market.playerProp && !playerName) continue;
          const marketLine =
            findNumber(marketObject, ["handicap", "line", "total"]) ??
            market.handicap;
          const line =
            marketLine != null && Math.abs(marketLine) > 0.0001
              ? marketLine
              : lineFromSelection(selection);
          const quote: NormalizedOddsQuote = {
            marketCategory: category,
            marketName: market.name,
            selection,
            playerName,
            line,
            bookmaker: bookmaker.name,
            upstreamBookmakerId: bookmaker.slug,
            upstreamMarketId: market.id,
            decimalOdds,
            sourceUpdatedAt:
              parseDate(pricing.changedAt ?? pricing.bookmakerChangedAt) ??
              parseDate(event.updatedAt),
          };
          const fingerprint = [
            quote.bookmaker,
            quote.marketName,
            quote.selection,
            quote.playerName ?? "",
            quote.line ?? "",
            quote.decimalOdds,
            quote.sourceUpdatedAt?.toISOString() ?? "",
          ].join("|");
          if (seen.has(fingerprint)) continue;
          seen.add(fingerprint);
          quotes.push(quote);
        }
      }
    }
  }
  return quotes;
}

function findEvents(
  root: unknown,
  tournaments: TournamentRef[],
  bookmakers: OddsPapiBookmaker[],
  participants: Record<string, string>,
  marketCatalog: OddsPapiMarket[],
): NormalizedOddsEvent[] {
  const events: NormalizedOddsEvent[] = [];
  const seen = new Set<string>();
  const tournamentById = new Map(
    tournaments.map((tournament) => [tournament.tournamentId, tournament.leagueCode]),
  );
  const markets = new Map(marketCatalog.map((market) => [market.id, market]));
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const object = record(value);
    if (!object) return;
    const tournamentId = findText(object, ["tournamentId", "tournament_id", "leagueId"]);
    const tournamentName = findText(object, ["tournamentName", "leagueName", "competitionName"]);
    const details = eventDetails(object, participants);
    if (details) {
      const leagueCode =
        (tournamentId ? tournamentById.get(tournamentId) : null) ??
        (tournamentName ? leagueForName(tournamentName) : null);
      if (leagueCode) {
        const identity = details.id ?? [
          leagueCode,
          normalizeName(details.home),
          normalizeName(details.away),
          details.kickoff.toISOString(),
        ].join("|");
        if (!seen.has(identity)) {
          seen.add(identity);
          events.push({
            oddsPapiFixtureId: details.id,
            leagueCode,
            homeTeam: details.home,
            awayTeam: details.away,
            kickoff: details.kickoff,
          status: details.status,
            quotes: extractQuotes(object, bookmakers, markets),
          });
        }
        return;
      }
    }
    for (const nested of Object.values(object)) visit(nested);
  };
  visit(root);
  return events;
}

export async function fetchTournamentOdds(
  tournaments: TournamentRef[],
  bookmaker: OddsPapiBookmaker,
  participants: Record<string, string>,
  markets: OddsPapiMarket[],
): Promise<{ events: NormalizedOddsEvent[]; quota: OddsPapiQuota }> {
  if (tournaments.length === 0) {
    throw new ProviderError("OddsPapi no tiene torneos configurados.");
  }
  const { body, quota } = await oddsPapiGet("/v4/odds-by-tournaments", {
    bookmaker: bookmaker.slug,
    tournamentIds: tournaments.map((tournament) => tournament.tournamentId).join(","),
    language: "en",
    verbosity: "3",
  });
  return {
    events: findEvents(body, tournaments, [bookmaker], participants, markets),
    quota,
  };
}