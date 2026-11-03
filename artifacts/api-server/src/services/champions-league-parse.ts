import type { ParsedResult } from "./football-data-parse";

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function teamName(value: string): string {
  return value.replace(/\s+\([A-Z]{3}\)$/, "").trim();
}

/**
 * Parses OpenFootball's CC0 football.txt format for completed main-stage UCL matches.
 * Kickoff times in this feed have no timezone, so dates are stored at noon UTC to avoid
 * shifting the match day while retaining stable matching and model recency.
 */
export function parseChampionsLeagueResults(
  text: string,
  seasonStartYear: number,
  now = new Date(),
): ParsedResult[] {
  const season = `${seasonStartYear}/${String(seasonStartYear + 1).slice(-2)}`;
  const results: ParsedResult[] = [];
  let currentYear = seasonStartYear;
  let currentMonth: number | null = null;
  let currentDay: number | null = null;

  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const dateMatch =
      /^\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Za-z]{3})\s+(\d{1,2})(?:,?\s+(\d{4}))?\s*$/i.exec(
        line,
      );
    if (dateMatch) {
      const month = MONTHS[dateMatch[1]!.toLowerCase()];
      const day = Number(dateMatch[2]);
      if (month == null || !Number.isInteger(day) || day < 1 || day > 31) {
        currentMonth = null;
        currentDay = null;
        continue;
      }
      const explicitYear = dateMatch[3] ? Number(dateMatch[3]) : null;
      if (explicitYear != null) currentYear = explicitYear;
      else if (currentMonth != null && month < currentMonth) currentYear += 1;
      currentMonth = month;
      currentDay = day;
      continue;
    }

    if (currentMonth == null || currentDay == null) continue;
    const match =
      /^\s*(?:(\d{1,2}):(\d{2})\s+)?(.+?)\s+v\s+(.+?)\s+(\d{1,2})\s*-\s*(\d{1,2})(?:\s+\([^)]*\))?(?:\s+.*)?$/i.exec(
        line,
      );
    if (!match) continue;

    const homeTeam = teamName(match[3]!);
    const awayTeam = teamName(match[4]!);
    const homeScore = Number(match[5]);
    const awayScore = Number(match[6]);
    const kickoff = new Date(
      Date.UTC(currentYear, currentMonth, currentDay, 12, 0, 0),
    );
    if (
      !homeTeam ||
      !awayTeam ||
      !Number.isInteger(homeScore) ||
      !Number.isInteger(awayScore) ||
      kickoff.getUTCMonth() !== currentMonth ||
      kickoff.getUTCDate() !== currentDay ||
      kickoff >= now
    ) {
      continue;
    }

    results.push({
      leagueCode: "champions-league",
      season,
      matchKey: `${kickoff.toISOString().slice(0, 10)}|${homeTeam}|${awayTeam}`,
      kickoff,
      homeTeam,
      awayTeam,
      homeScore,
      awayScore,
      homeCorners: null,
      awayCorners: null,
      homeYellowCards: null,
      awayYellowCards: null,
      homeRedCards: null,
      awayRedCards: null,
      homeShotsOnTarget: null,
      awayShotsOnTarget: null,
    });
  }

  return results;
}
