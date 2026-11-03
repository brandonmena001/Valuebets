import { sql } from "drizzle-orm";
import { db, historicalResultsTable } from "@workspace/db";
import { currentSeasonStartYear } from "./football-data-parse";
import { parseChampionsLeagueResults } from "./champions-league-parse";

const IMPORT_INTERVAL_MS = 12 * 60 * 60 * 1000;
const FORCED_IMPORT_INTERVAL_MS = 30 * 60 * 1000;
const SEASONS_TO_KEEP = 5;
const PAUSE_BETWEEN_DOWNLOADS_MS = 250;
const BASE_URL =
  "https://raw.githubusercontent.com/openfootball/champions-league/master";

let lastImportAt = 0;

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function upsertResults(
  rows: ReturnType<typeof parseChampionsLeagueResults>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += 200) {
    await db
      .insert(historicalResultsTable)
      .values(
        rows.slice(i, i + 200).map((row) => ({
          ...row,
          source: "openfootball",
        })),
      )
      .onConflictDoUpdate({
        target: [historicalResultsTable.leagueCode, historicalResultsTable.matchKey],
        set: {
          season: sql`excluded.season`,
          kickoff: sql`excluded.kickoff`,
          homeTeam: sql`excluded.home_team`,
          awayTeam: sql`excluded.away_team`,
          homeScore: sql`excluded.home_score`,
          awayScore: sql`excluded.away_score`,
          source: sql`excluded.source`,
          updatedAt: new Date(),
        },
      });
  }
}

/**
 * Imports the five most recent completed UCL seasons from OpenFootball's CC0 dataset.
 * This feed supplies scores (not corners, cards, or player statistics).
 */
export async function importChampionsLeagueHistory(
  options: { force?: boolean; now?: Date } = {},
): Promise<{ rows: number; errors: string[]; skipped: boolean }> {
  const now = options.now ?? new Date();
  const minInterval = options.force
    ? FORCED_IMPORT_INTERVAL_MS
    : IMPORT_INTERVAL_MS;
  if (Date.now() - lastImportAt < minInterval) {
    return { rows: 0, errors: [], skipped: true };
  }
  lastImportAt = Date.now();

  const currentStartYear = currentSeasonStartYear(now);
  const firstStartYear = currentStartYear - SEASONS_TO_KEEP;
  const errors: string[] = [];
  let total = 0;

  for (
    let seasonStartYear = firstStartYear;
    seasonStartYear < currentStartYear;
    seasonStartYear += 1
  ) {
    if (seasonStartYear > firstStartYear) {
      await sleep(PAUSE_BETWEEN_DOWNLOADS_MS);
    }
    const season = `${seasonStartYear}-${String(seasonStartYear + 1).slice(-2)}`;
    const url = `${BASE_URL}/${season}/cl.txt`;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
        headers: { "User-Agent": "ValueBets/1.0 (historical match results)" },
      });
      if (!response.ok) {
        errors.push(`${season}: HTTP ${response.status}`);
        continue;
      }
      const rows = parseChampionsLeagueResults(
        await response.text(),
        seasonStartYear,
        now,
      );
      if (!rows.length) {
        errors.push(`${season}: no se encontraron resultados completos`);
        continue;
      }
      await upsertResults(rows);
      total += rows.length;
    } catch (error) {
      errors.push(
        `${season}: ${error instanceof Error ? error.message : "error desconocido"}`,
      );
    }
  }

  return { rows: total, errors, skipped: false };
}
