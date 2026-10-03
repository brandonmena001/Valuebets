export type LeagueCode = "premier-league" | "la-liga" | "bundesliga";

export const apiFootballLeagues: Array<{
  code: LeagueCode;
  id: number;
  name: string;
  country: string;
}> = [
  { code: "premier-league", id: 39, name: "Premier League", country: "England" },
  { code: "la-liga", id: 140, name: "LaLiga", country: "Spain" },
  { code: "bundesliga", id: 78, name: "Bundesliga", country: "Germany" },
];

type ApiResponse<T> = {
  response?: T[];
  errors?: unknown;
};

type ApiFixture = {
  fixture?: {
    id?: number;
    date?: string;
    status?: { short?: string };
  };
  league?: { id?: number; name?: string; country?: string };
  teams?: {
    home?: { id?: number; name?: string };
    away?: { id?: number; name?: string };
  };
  goals?: { home?: number | null; away?: number | null };
};

export type NormalizedFixture = {
  apiFootballFixtureId: number;
  leagueCode: LeagueCode;
  leagueName: string;
  country: string;
  homeTeamApiId: number | null;
  awayTeamApiId: number | null;
  homeTeam: string;
  awayTeam: string;
  kickoff: Date;
  status: "scheduled" | "live" | "finished" | "postponed" | "cancelled" | "unknown";
  homeScore: number | null;
  awayScore: number | null;
};

export type NormalizedMatchStats = {
  homeCorners: number | null;
  awayCorners: number | null;
  homeYellowCards: number | null;
  awayYellowCards: number | null;
  homeRedCards: number | null;
  awayRedCards: number | null;
  homeShotsOnTarget: number | null;
  awayShotsOnTarget: number | null;
};

export type NormalizedPlayerStats = {
  playerApiId: number;
  playerName: string;
  teamApiId: number | null;
  minutesPlayed: number | null;
  shotsOnTarget: number | null;
};

export type ProviderQuota = {
  requestsRemaining: number | null;
  requestLimit: number | null;
};

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

function getSeason(now = new Date()): number {
  const year = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? year : year - 1;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function fixtureWindow(now = new Date()): { from: string; to: string } {
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - 30);
  const to = new Date(now);
  to.setUTCDate(to.getUTCDate() + 14);
  return { from: isoDate(from), to: isoDate(to) };
}

function apiFootballKey(): string {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new ProviderError("API-Football no está configurado.");
  return key;
}

export async function apiFootballGet<T>(
  path: string,
  params: Record<string, string | number>,
): Promise<{ body: ApiResponse<T>; quota: ProviderQuota }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) query.set(key, String(value));
  const response = await fetch(
    `https://v3.football.api-sports.io/${path}?${query.toString()}`,
    {
      headers: { "x-apisports-key": apiFootballKey() },
      signal: AbortSignal.timeout(25_000),
    },
  );

  const quota: ProviderQuota = {
    requestsRemaining: parseHeader(response.headers.get("x-ratelimit-requests-remaining")),
    requestLimit: parseHeader(response.headers.get("x-ratelimit-requests-limit")),
  };
  if (!response.ok) {
    throw new ProviderError(`API-Football respondió HTTP ${response.status}.`, response.status);
  }

  const body = (await response.json()) as ApiResponse<T>;
  if (body.errors && Object.keys(body.errors as object).length > 0) {
    const errors =
      typeof body.errors === "object" && body.errors != null
        ? (body.errors as Record<string, unknown>)
        : {};
    const planError = errors.plan;
    const fields = Object.keys(errors).slice(0, 5).join(", ");
    let safePlanMessage =
      typeof planError === "string" ? planError : "";
    const secret = process.env.API_FOOTBALL_KEY;
    if (secret) safePlanMessage = safePlanMessage.split(secret).join("[credencial]");
    safePlanMessage = safePlanMessage
      .replace(/([?&](?:apiKey|token)=)[^&\s]+/gi, "$1[redactado]")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[correo]")
      .replace(/\s+/g, " ")
      .slice(0, 240);
    throw new ProviderError(
      safePlanMessage
        ? `API-Football: ${safePlanMessage}`
        : fields
        ? `API-Football devolvió errores en los campos: ${fields}.`
        : "API-Football devolvió un error en la respuesta.",
    );
  }
  return { body, quota };
}

function parseHeader(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStatus(status?: string): NormalizedFixture["status"] {
  const code = (status ?? "").toUpperCase();
  if (["FT", "AET", "PEN", "AWD", "WO"].includes(code)) return "finished";
  if (["1H", "HT", "2H", "ET", "BT", "P", "LIVE"].includes(code)) return "live";
  if (["PST", "SUSP"].includes(code)) return "postponed";
  if (["CANC", "ABD"].includes(code)) return "cancelled";
  if (["NS", "TBD"].includes(code)) return "scheduled";
  return "unknown";
}

export async function fetchLeagueFixtures(
  league: (typeof apiFootballLeagues)[number],
  now = new Date(),
): Promise<{ fixtures: NormalizedFixture[]; quota: ProviderQuota }> {
  const { from, to } = fixtureWindow(now);
  const result = await apiFootballGet<ApiFixture>("fixtures", {
    league: league.id,
    season: getSeason(now),
    from,
    to,
  });
  const fixtures = (result.body.response ?? []).flatMap((item) => {
    const id = item.fixture?.id;
    const kickoff = item.fixture?.date ? new Date(item.fixture.date) : null;
    const home = item.teams?.home;
    const away = item.teams?.away;
    if (
      id == null ||
      kickoff == null ||
      Number.isNaN(kickoff.getTime()) ||
      !home?.name ||
      !away?.name
    ) {
      return [];
    }
    return [{
      apiFootballFixtureId: id,
      leagueCode: league.code,
      leagueName: item.league?.name ?? league.name,
      country: item.league?.country ?? league.country,
      homeTeamApiId: home.id ?? null,
      awayTeamApiId: away.id ?? null,
      homeTeam: home.name,
      awayTeam: away.name,
      kickoff,
      status: normalizeStatus(item.fixture?.status?.short),
      homeScore: item.goals?.home ?? null,
      awayScore: item.goals?.away ?? null,
    }];
  });
  return { fixtures, quota: result.quota };
}

type ApiTeamStatistics = {
  team?: { id?: number };
  statistics?: Array<{ type?: string; value?: number | string | null }>;
};

function numericStat(
  teamStats: ApiTeamStatistics | undefined,
  names: string[],
): number | null {
  const found = teamStats?.statistics?.find((stat) =>
    names.some((name) => stat.type?.toLowerCase() === name.toLowerCase()),
  )?.value;
  if (found == null) return null;
  const value = typeof found === "number" ? found : Number.parseInt(found, 10);
  return Number.isFinite(value) ? value : null;
}

export async function fetchMatchStatistics(
  fixtureId: number,
): Promise<{ stats: NormalizedMatchStats; quota: ProviderQuota }> {
  const result = await apiFootballGet<ApiTeamStatistics>("fixtures/statistics", {
    fixture: fixtureId,
  });
  const [home, away] = result.body.response ?? [];
  const stats: NormalizedMatchStats = {
    homeCorners: numericStat(home, ["Corner Kicks", "Corners"]),
    awayCorners: numericStat(away, ["Corner Kicks", "Corners"]),
    homeYellowCards: numericStat(home, ["Yellow Cards"]),
    awayYellowCards: numericStat(away, ["Yellow Cards"]),
    homeRedCards: numericStat(home, ["Red Cards"]),
    awayRedCards: numericStat(away, ["Red Cards"]),
    homeShotsOnTarget: numericStat(home, ["Shots on Goal", "Shots on Target"]),
    awayShotsOnTarget: numericStat(away, ["Shots on Goal", "Shots on Target"]),
  };
  return { stats, quota: result.quota };
}

type ApiPlayer = {
  player?: { id?: number; name?: string };
  statistics?: Array<{
    games?: { minutes?: number | string | null };
    shots?: { on?: number | null };
  }>;
};

type ApiPlayerTeam = { team?: { id?: number }; players?: ApiPlayer[] };

export async function fetchPlayerStatistics(
  fixtureId: number,
): Promise<{ players: NormalizedPlayerStats[]; quota: ProviderQuota }> {
  const result = await apiFootballGet<ApiPlayerTeam>("fixtures/players", {
    fixture: fixtureId,
  });
  const players = (result.body.response ?? []).flatMap((team) =>
    (team.players ?? []).flatMap((record) => {
      const player = record.player;
      const stats = record.statistics?.[0];
      if (player?.id == null || !player.name || !stats) return [];
      const rawMinutes = stats.games?.minutes;
      const minutes =
        typeof rawMinutes === "number"
          ? rawMinutes
          : typeof rawMinutes === "string"
            ? Number.parseInt(rawMinutes, 10)
            : null;
      return [{
        playerApiId: player.id,
        playerName: player.name,
        teamApiId: team.team?.id ?? null,
        minutesPlayed: minutes != null && Number.isFinite(minutes) ? minutes : null,
        shotsOnTarget: stats.shots?.on ?? null,
      }];
    }),
  );
  return { players, quota: result.quota };
}