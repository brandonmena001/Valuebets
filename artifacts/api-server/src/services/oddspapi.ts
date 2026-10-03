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
  if (!response.ok) {
    throw new ProviderError(`OddsPapi respondió HTTP ${response.status}.`, response.status);
  }
  return { body: await response.json(), quota };
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
  return { home, away, kickoff, id };
}

function classifyMarket(market: string): NormalizedOddsQuote["marketCategory"] | null {
  const normalized = market.toLowerCase();
  if (/shot.*target|shots on target|shots on goal/.test(normalized)) return "shots-on-target";
  if (/corner/.test(normalized)) return "corners";
  if (/card|booking/.test(normalized)) return "cards";
  if (/goal|total over|over\/under|over under/.test(normalized)) return "goals";
  if (/1x2|match result|match winner|full.?time result|three.?way/.test(normalized)) return "match-result";
  return null;
}

type QuoteContext = {
  bookmaker: string;
  upstreamBookmakerId: string | null;
  marketName: string | null;
  upstreamMarketId: string | null;
  selection: string | null;
  playerName: string | null;
  line: number | null;
  sourceUpdatedAt: Date | null;
};

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function extractQuotes(root: unknown, requestedBookmaker: string): NormalizedOddsQuote[] {
  const quotes: NormalizedOddsQuote[] = [];
  const seen = new Set<string>();

  const visit = (value: unknown, context: QuoteContext, keyPath = ""): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, context, keyPath);
      return;
    }
    const object = record(value);
    if (!object) return;

    const next: QuoteContext = { ...context };
    const bookObject = record(object.bookmaker) ?? record(object.book);
    const explicitBook = findText(object, ["bookmakerName", "bookName"]);
    if (explicitBook) next.bookmaker = explicitBook;
    if (bookObject) {
      next.bookmaker = findText(bookObject, ["name", "title", "label"]) ?? next.bookmaker;
      next.upstreamBookmakerId = findText(bookObject, ["id", "key", "bookmakerId"]) ?? next.upstreamBookmakerId;
    } else if (/bookmaker|sportsbook|bookmaker/i.test(keyPath)) {
      next.bookmaker = findText(object, ["name", "title", "label"]) ?? next.bookmaker;
      next.upstreamBookmakerId = findText(object, ["id", "key", "bookmakerId"]) ?? next.upstreamBookmakerId;
    }

    const possibleMarket = findText(object, ["marketName", "market", "market_name"]);
    if (possibleMarket && classifyMarket(possibleMarket)) next.marketName = possibleMarket;
    if (!next.marketName) {
      const name = findText(object, ["name", "title"]);
      if (name && classifyMarket(name)) {
        next.marketName = name;
        next.upstreamMarketId = findText(object, ["marketId", "market_id", "id"]);
      }
    }

    const selection = findText(object, ["selection", "outcomeName", "outcome", "label", "participantName"]);
    if (selection && !classifyMarket(selection)) next.selection = selection;
    const player =
      findText(object, ["playerName", "player"]) ??
      (/player/i.test(keyPath) ? findText(object, ["name", "fullName"]) : null);
    if (player) next.playerName = player;
    next.line = findNumber(object, ["line", "handicap", "points", "total", "threshold"]) ?? next.line;
    next.sourceUpdatedAt =
      parseDate(object.updatedAt ?? object.updated_at ?? object.lastUpdated ?? object.timestamp) ??
      next.sourceUpdatedAt;

    const price = findNumber(object, ["decimalOdds", "odds", "price", "value"]);
    const category = next.marketName ? classifyMarket(next.marketName) : null;
    if (price != null && price > 1 && category && next.selection) {
      const lineMatch = next.selection.match(
        /(?:over|under|more than|less than|más de|mas de|menos de)\s*(\d+(?:[.,]\d+)?)/i,
      );
      const inferredLine = Number(lineMatch?.[1]?.replace(",", "."));
      const line =
        next.line ?? (Number.isFinite(inferredLine) ? inferredLine : null);
      const quote: NormalizedOddsQuote = {
        marketCategory: category,
        marketName: next.marketName!,
        selection: next.selection,
        playerName: next.playerName,
        line: Number.isFinite(line) ? line : null,
        bookmaker: next.bookmaker,
        upstreamBookmakerId: next.upstreamBookmakerId,
        upstreamMarketId: next.upstreamMarketId,
        decimalOdds: price,
        sourceUpdatedAt: next.sourceUpdatedAt,
      };
      const fingerprint = [
        quote.bookmaker,
        quote.marketName,
        quote.selection,
        quote.line,
        quote.decimalOdds,
        quote.sourceUpdatedAt?.toISOString(),
      ].join("|");
      if (!seen.has(fingerprint)) {
        seen.add(fingerprint);
        quotes.push(quote);
      }
    }

    for (const [key, nested] of Object.entries(object)) {
      if (nested !== value) visit(nested, next, key);
    }
  };

  visit(root, {
    bookmaker: requestedBookmaker,
    upstreamBookmakerId: null,
    marketName: null,
    upstreamMarketId: null,
    selection: null,
    playerName: null,
    line: null,
    sourceUpdatedAt: null,
  });
  return quotes;
}

function findEvents(
  root: unknown,
  tournaments: TournamentRef[],
  requestedBookmaker: string,
): NormalizedOddsEvent[] {
  const events: NormalizedOddsEvent[] = [];
  const seen = new Set<string>();
  const tournamentById = new Map(
    tournaments.map((tournament) => [tournament.tournamentId, tournament.leagueCode]),
  );
  const visit = (
    value: unknown,
    inheritedTournamentId: string | null = null,
    inheritedTournamentName: string | null = null,
  ): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inheritedTournamentId, inheritedTournamentName);
      return;
    }
    const object = record(value);
    if (!object) return;
    const tournamentId =
      findText(object, ["tournamentId", "tournament_id", "leagueId"]) ??
      inheritedTournamentId;
    const tournamentName =
      findText(object, ["tournamentName", "leagueName", "competitionName"]) ??
      inheritedTournamentName;
    const details = eventDetails(object);
    if (details) {
      const leagueCode =
        (tournamentId ? tournamentById.get(tournamentId) : null) ??
        (tournamentName ? leagueForName(tournamentName) : null);
      if (!leagueCode) return;
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
          quotes: extractQuotes(object, requestedBookmaker),
        });
      }
      return;
    }
    for (const nested of Object.values(object)) {
      visit(nested, tournamentId, tournamentName);
    }
  };
  visit(root);
  return events;
}

export async function fetchTournamentOdds(
  tournaments: TournamentRef[],
  bookmakerKey: string,
  bookmakerLabel: string,
): Promise<{ events: NormalizedOddsEvent[]; quota: OddsPapiQuota }> {
  if (tournaments.length === 0) {
    throw new ProviderError("OddsPapi no tiene torneos configurados.");
  }
  const { body, quota } = await oddsPapiGet("/v4/odds-by-tournaments", {
    bookmaker: bookmakerKey,
    tournamentIds: tournaments.map((tournament) => tournament.tournamentId).join(","),
  });
  return {
    events: findEvents(body, tournaments, bookmakerLabel),
    quota,
  };
}