import { sql } from "drizzle-orm";
import { db, historicalResultsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  currentSeasonStartYear,
  parseFootballDataCsv,
  parseFootballDataFixtures,
  seasonCode,
  type ParsedFixture,
  type ParsedResult,
} from "./football-data-parse";

const LEAGUE_FILES: Record<string, string> = {
  "premier-league": "E0",
  "la-liga": "SP1",
  bundesliga: "D1",
};
const MIN_INTERVAL_MS = 3 * 60 * 60 * 1000;
let lastImportAt = 0;

async function upsert(rows: ParsedResult[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 200) {
    await db
      .insert(historicalResultsTable)
      .values(rows.slice(i, i + 200))
      .onConflictDoUpdate({
        target: [historicalResultsTable.leagueCode, historicalResultsTable.matchKey],
        set: {
          homeScore: sql`excluded.home_score`, awayScore: sql`excluded.away_score`,
          homeCorners: sql`excluded.home_corners`, awayCorners: sql`excluded.away_corners`,
          homeYellowCards: sql`excluded.home_yellow_cards`, awayYellowCards: sql`excluded.away_yellow_cards`,
          homeRedCards: sql`excluded.home_red_cards`, awayRedCards: sql`excluded.away_red_cards`,
          homeShotsOnTarget: sql`excluded.home_shots_on_target`, awayShotsOnTarget: sql`excluded.away_shots_on_target`,
          updatedAt: new Date(),
        },
      });
  }
}

/**
 * Importa la temporada actual y la anterior de las tres ligas. Gratuito y sin cuota;
 * football-data actualiza los CSV un par de veces por semana. Nunca lanza: devuelve
 * los errores para registrarlos, así un fallo no frena el resto de la sincronización.
 */
export async function importFootballData(
  options: { force?: boolean; now?: Date } = {},
): Promise<{ rows: number; errors: string[]; skipped: boolean }> {
  const now = options.now ?? new Date();
  if (!options.force && Date.now() - lastImportAt < MIN_INTERVAL_MS) {
    return { rows: 0, errors: [], skipped: true };
  }
  lastImportAt = Date.now();
  const start = currentSeasonStartYear(now);
  const errors: string[] = [];
  let total = 0;
  for (const [league, file] of Object.entries(LEAGUE_FILES)) {
    for (const season of [seasonCode(start), seasonCode(start - 1)]) {
      const url = `https://www.football-data.co.uk/mmz4281/${season}/${file}.csv`;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
        if (!response.ok) {
          errors.push(`${league} ${season}: HTTP ${response.status}`);
          continue;
        }
        const rows = parseFootballDataCsv(await response.text(), league, season);
        if (!rows.length) {
          errors.push(`${league} ${season}: sin filas reconocibles`);
          continue;
        }
        await upsert(rows);
        total += rows.length;
      } catch (error) {
        errors.push(`${league} ${season}: ${error instanceof Error ? error.message : "error desconocido"}`);
      }
    }
  }
  logger.info({ rows: total, errors }, "football-data history import finished");
  return { rows: total, errors, skipped: false };
}

const DIV_TO_LEAGUE: Record<string, string> = { E0: "premier-league", SP1: "la-liga", D1: "bundesliga" };
const FIXTURES_CACHE_MS = 3 * 60 * 60 * 1000;
let fixturesCache: { loadedAt: number; fixtures: ParsedFixture[] } | null = null;

/**
 * Próximos partidos de las tres ligas desde fixtures.csv (gratuito, sin cuota). Solo se usa como
 * calendario para decidir cuándo gastar llamadas de OddsPapi: no escribe en la base de datos.
 * Nunca lanza; `ok: false` significa "calendario desconocido".
 */
export async function fetchUpcomingFixtures(): Promise<{ ok: boolean; fixtures: ParsedFixture[]; error?: string }> {
  if (fixturesCache && Date.now() - fixturesCache.loadedAt < FIXTURES_CACHE_MS) {
    return { ok: true, fixtures: fixturesCache.fixtures };
  }
  try {
    const response = await fetch("https://www.football-data.co.uk/fixtures.csv", { signal: AbortSignal.timeout(25_000) });
    if (!response.ok) return { ok: false, fixtures: [], error: `fixtures.csv: HTTP ${response.status}` };
    const fixtures = parseFootballDataFixtures(await response.text(), DIV_TO_LEAGUE);
    fixturesCache = { loadedAt: Date.now(), fixtures };
    return { ok: true, fixtures };
  } catch (error) {
    return { ok: false, fixtures: [], error: `fixtures.csv: ${error instanceof Error ? error.message : "error desconocido"}` };
  }
}
