import { and, eq, gt, gte, inArray, lt } from "drizzle-orm";
import {
  db,
  matchesTable,
  matchStatsTable,
  modelPredictionsTable,
  oddsQuotesTable,
  playerMatchStatsTable,
} from "@workspace/db";

const MODEL_VERSION = "poisson-baseline-v1";
const MIN_ODDS_AGE_MS = 12 * 60 * 60 * 1000;
const MIN_TEAM_SAMPLES = 8;
const MIN_PLAYER_SAMPLES = 8;

type HistoryMatch = {
  matchId: number;
  leagueCode: string;
  homeTeam: string;
  awayTeam: string;
  kickoff: Date;
  homeScore: number | null;
  awayScore: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  homeYellowCards: number | null;
  awayYellowCards: number | null;
  homeRedCards: number | null;
  awayRedCards: number | null;
  homeShotsOnTarget: number | null;
  awayShotsOnTarget: number | null;
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function poissonMass(lambda: number, value: number): number {
  if (lambda <= 0) return value === 0 ? 1 : 0;
  let result = Math.exp(-lambda);
  for (let index = 1; index <= value; index += 1) {
    result *= lambda / index;
  }
  return result;
}

function poissonTail(lambda: number, minimum: number): number {
  if (minimum <= 0) return 1;
  let below = 0;
  for (let value = 0; value < minimum; value += 1) {
    below += poissonMass(lambda, value);
  }
  return Math.max(0, Math.min(1, 1 - below));
}

function normalizedCount(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value != null && Number.isFinite(value));
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function matchesForTeam(
  history: HistoryMatch[],
  teamName: string,
  selector: (row: HistoryMatch) => number | null,
): number[] {
  const team = normalize(teamName);
  return history
    .filter((row) => normalize(row.homeTeam) === team || normalize(row.awayTeam) === team)
    .sort((a, b) => b.kickoff.getTime() - a.kickoff.getTime())
    .slice(0, 12)
    .map(selector)
    .filter((value): value is number => value != null && Number.isFinite(value));
}

function teamGoalExpectations(
  history: HistoryMatch[],
  match: { homeTeam: string; awayTeam: string; leagueCode: string },
): { home: number; away: number; sampleSize: number } | null {
  const league = history.filter(
    (row) =>
      row.leagueCode === match.leagueCode &&
      row.homeScore != null &&
      row.awayScore != null,
  );
  const leagueHomeAverage = mean(league.map((row) => row.homeScore!));
  const leagueAwayAverage = mean(league.map((row) => row.awayScore!));
  if (league.length < MIN_TEAM_SAMPLES || !leagueHomeAverage || !leagueAwayAverage) return null;

  const homeGames = league.filter((row) => normalize(row.homeTeam) === normalize(match.homeTeam));
  const awayGames = league.filter((row) => normalize(row.awayTeam) === normalize(match.awayTeam));
  if (homeGames.length < 4 || awayGames.length < 4) return null;

  const homeAttack = mean(homeGames.map((row) => row.homeScore!));
  const homeConceded = mean(homeGames.map((row) => row.awayScore!));
  const awayAttack = mean(awayGames.map((row) => row.awayScore!));
  const awayConceded = mean(awayGames.map((row) => row.homeScore!));
  if (
    homeAttack == null ||
    homeConceded == null ||
    awayAttack == null ||
    awayConceded == null
  ) return null;

  const homeLambda = Math.min(
    4.5,
    Math.max(0.15, (homeAttack / leagueHomeAverage) * (awayConceded / leagueHomeAverage) * leagueHomeAverage),
  );
  const awayLambda = Math.min(
    4.5,
    Math.max(0.15, (awayAttack / leagueAwayAverage) * (homeConceded / leagueAwayAverage) * leagueAwayAverage),
  );
  return {
    home: homeLambda,
    away: awayLambda,
    sampleSize: Math.min(homeGames.length, awayGames.length),
  };
}

function resultProbability(
  selection: string,
  homeTeam: string,
  awayTeam: string,
  lambdas: { home: number; away: number },
): number | null {
  const home = normalize(homeTeam);
  const away = normalize(awayTeam);
  const pick = normalize(selection);
  let probability = 0;
  for (let homeGoals = 0; homeGoals <= 10; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals <= 10; awayGoals += 1) {
      let selected = false;
      if (
        homeGoals > awayGoals &&
        (pick === "1" || pick === "home" || pick === home || pick.includes(home))
      ) selected = true;
      if (
        awayGoals > homeGoals &&
        (pick === "2" || pick === "away" || pick === away || pick.includes(away))
      ) selected = true;
      if (
        homeGoals === awayGoals &&
        ["x", "draw", "tie", "empate"].includes(pick)
      ) selected = true;
      if (selected) {
        probability +=
          poissonMass(lambdas.home, homeGoals) *
          poissonMass(lambdas.away, awayGoals);
      }
    }
  }
  return probability > 0 ? Math.min(1, probability) : null;
}

function parseOverUnder(selection: string): "over" | "under" | null {
  const normalized = normalize(selection);
  if (/\b(over|more|mas|mayor)\b/.test(normalized)) return "over";
  if (/\b(under|less|menos|menor)\b/.test(normalized)) return "under";
  return null;
}

function isHalfLine(line: number): boolean {
  return Math.abs(line - Math.round(line)) > 0.05;
}

function overUnderProbability(
  selection: string,
  line: number | null,
  lambda: number,
): number | null {
  const direction = parseOverUnder(selection);
  if (line == null || !isHalfLine(line) || !direction) return null;
  const minimumOver = Math.floor(line) + 1;
  const overProbability = poissonTail(lambda, minimumOver);
  return direction === "over" ? overProbability : 1 - overProbability;
}

function averageTeamStat(
  history: HistoryMatch[],
  teamName: string,
  homeSelector: (row: HistoryMatch) => number | null,
  awaySelector: (row: HistoryMatch) => number | null,
): { average: number; sampleSize: number } | null {
  const team = normalize(teamName);
  const games = history
    .filter(
      (row) =>
        (normalize(row.homeTeam) === team && homeSelector(row) != null) ||
        (normalize(row.awayTeam) === team && awaySelector(row) != null),
    )
    .sort((a, b) => b.kickoff.getTime() - a.kickoff.getTime())
    .slice(0, 12);
  const values = games.map((row) =>
    normalize(row.homeTeam) === team ? homeSelector(row) : awaySelector(row),
  );
  const numeric = normalizedCount(values);
  const average = mean(numeric);
  return average == null ? null : { average, sampleSize: numeric.length };
}

function matchStatTotal(
  history: HistoryMatch[],
  quote: {
    marketCategory: string;
    marketName: string;
    selection: string;
    line: number | null;
  },
  match: { homeTeam: string; awayTeam: string; leagueCode: string },
): { probability: number; sampleSize: number } | null {
  if (quote.marketCategory === "goals") {
    const lambdas = teamGoalExpectations(history, match);
    if (!lambdas) return null;
    const probability = overUnderProbability(
      quote.selection,
      quote.line,
      lambdas.home + lambdas.away,
    );
    return probability == null
      ? null
      : { probability, sampleSize: lambdas.sampleSize };
  }

  let homeSelector: (row: HistoryMatch) => number | null;
  let awaySelector: (row: HistoryMatch) => number | null;
  if (quote.marketCategory === "corners") {
    homeSelector = (row) =>
      row.homeCorners == null || row.awayCorners == null
        ? null
        : row.homeCorners + row.awayCorners;
    awaySelector = homeSelector;
  } else if (quote.marketCategory === "shots-on-target") {
    homeSelector = (row) =>
      row.homeShotsOnTarget == null || row.awayShotsOnTarget == null
        ? null
        : row.homeShotsOnTarget + row.awayShotsOnTarget;
    awaySelector = homeSelector;
  } else {
    return null;
  }

  const home = averageTeamStat(history, match.homeTeam, homeSelector, awaySelector);
  const away = averageTeamStat(history, match.awayTeam, homeSelector, awaySelector);
  if (!home || !away) return null;
  const sampleSize = Math.min(home.sampleSize, away.sampleSize);
  if (sampleSize < MIN_TEAM_SAMPLES) return null;
  const probability = overUnderProbability(
    quote.selection,
    quote.line,
    (home.average + away.average) / 2,
  );
  return probability == null ? null : { probability, sampleSize };
}

function playerStatProbability(
  quote: {
    selection: string;
    line: number | null;
    playerName: string | null;
  },
  playerRows: Array<{
    playerName: string;
    kickoff: Date;
    minutesPlayed: number | null;
    shotsOnTarget: number | null;
  }>,
  matchKickoff: Date,
): { probability: number; sampleSize: number } | null {
  if (!quote.playerName) return null;
  const target = normalize(quote.playerName);
  const history = playerRows
    .filter(
      (row) =>
        normalize(row.playerName) === target &&
        row.kickoff < matchKickoff &&
        (row.minutesPlayed == null || row.minutesPlayed >= 30) &&
        row.shotsOnTarget != null,
    )
    .sort((a, b) => b.kickoff.getTime() - a.kickoff.getTime())
    .slice(0, 12);
  const sampleSize = history.length;
  if (sampleSize < MIN_PLAYER_SAMPLES) return null;
  const lambda = mean(
    history.map((row) => row.shotsOnTarget as number),
  );
  if (lambda == null) return null;
  const probability = overUnderProbability(quote.selection, quote.line, lambda);
  return probability == null ? null : { probability, sampleSize };
}

function getProbability(
  quote: {
    marketCategory: string;
    marketName: string;
    selection: string;
    playerName: string | null;
    line: number | null;
  },
  match: {
    homeTeam: string;
    awayTeam: string;
    leagueCode: string;
    kickoff: Date;
  },
  history: HistoryMatch[],
  playerRows: Array<{
    playerName: string;
    kickoff: Date;
    minutesPlayed: number | null;
    shotsOnTarget: number | null;
  }>,
): { probability: number; sampleSize: number } | null {
  if (quote.marketCategory === "match-result") {
    const lambdas = teamGoalExpectations(history, match);
    if (!lambdas || lambdas.sampleSize < MIN_TEAM_SAMPLES) return null;
    const probability = resultProbability(
      quote.selection,
      match.homeTeam,
      match.awayTeam,
      lambdas,
    );
    return probability == null
      ? null
      : { probability, sampleSize: lambdas.sampleSize };
  }
  if (quote.marketCategory === "shots-on-target" && quote.playerName) {
    return playerStatProbability(quote, playerRows, match.kickoff);
  }
  return matchStatTotal(history, quote, match);
}

export async function refreshModelPredictions(): Promise<void> {
  const historyRows = await db
    .select({
      matchId: matchesTable.id,
      leagueCode: matchesTable.leagueCode,
      homeTeam: matchesTable.homeTeam,
      awayTeam: matchesTable.awayTeam,
      kickoff: matchesTable.kickoff,
      homeScore: matchesTable.homeScore,
      awayScore: matchesTable.awayScore,
      homeCorners: matchStatsTable.homeCorners,
      awayCorners: matchStatsTable.awayCorners,
      homeYellowCards: matchStatsTable.homeYellowCards,
      awayYellowCards: matchStatsTable.awayYellowCards,
      homeRedCards: matchStatsTable.homeRedCards,
      awayRedCards: matchStatsTable.awayRedCards,
      homeShotsOnTarget: matchStatsTable.homeShotsOnTarget,
      awayShotsOnTarget: matchStatsTable.awayShotsOnTarget,
    })
    .from(matchesTable)
    .leftJoin(matchStatsTable, eq(matchesTable.id, matchStatsTable.matchId))
    .where(eq(matchesTable.status, "finished"));

  const history = historyRows as HistoryMatch[];
  const quotes = await db
    .select({
      quote: oddsQuotesTable,
      matchId: matchesTable.id,
      leagueCode: matchesTable.leagueCode,
      homeTeam: matchesTable.homeTeam,
      awayTeam: matchesTable.awayTeam,
      kickoff: matchesTable.kickoff,
      status: matchesTable.status,
    })
    .from(oddsQuotesTable)
    .innerJoin(matchesTable, eq(oddsQuotesTable.matchId, matchesTable.id))
    .where(
      and(
        gt(matchesTable.kickoff, new Date()),
        gte(oddsQuotesTable.capturedAt, new Date(Date.now() - MIN_ODDS_AGE_MS)),
      ),
    );

  const quoteIds = quotes.map((item) => item.quote.id);
  const playerRows = quoteIds.length
    ? await db
        .select({
          playerName: playerMatchStatsTable.playerName,
          kickoff: matchesTable.kickoff,
          minutesPlayed: playerMatchStatsTable.minutesPlayed,
          shotsOnTarget: playerMatchStatsTable.shotsOnTarget,
        })
        .from(playerMatchStatsTable)
        .innerJoin(matchesTable, eq(playerMatchStatsTable.matchId, matchesTable.id))
    : [];

  const predictionRows: Array<typeof modelPredictionsTable.$inferInsert> = [];
  for (const item of quotes) {
    if (item.status === "live" || item.status === "finished") continue;
    const prediction = getProbability(
      {
        marketCategory: item.quote.marketCategory,
        marketName: item.quote.marketName,
        selection: item.quote.selection,
        playerName: item.quote.playerName,
        line: item.quote.line,
      },
      {
        homeTeam: item.homeTeam,
        awayTeam: item.awayTeam,
        leagueCode: item.leagueCode,
        kickoff: item.kickoff,
      },
      history.filter((row) => row.leagueCode === item.leagueCode),
      playerRows,
    );
    if (!prediction || prediction.sampleSize < MIN_TEAM_SAMPLES) continue;
    const expectedValuePct =
      (prediction.probability * item.quote.decimalOdds - 1) * 100;
    if (expectedValuePct < 5 || expectedValuePct > 100) continue;
    const modelProbability = Math.max(0.001, Math.min(0.999, prediction.probability));
    predictionRows.push({
      oddsQuoteId: item.quote.id,
      modelProbability,
      fairOdds: 1 / modelProbability,
      expectedValuePct,
      modelVersion: MODEL_VERSION,
      sampleSize: prediction.sampleSize,
      confidence:
        prediction.sampleSize >= 16
          ? "high"
          : prediction.sampleSize >= 10
            ? "medium"
            : "low",
    });
  }

  await db.delete(modelPredictionsTable);
  if (predictionRows.length) {
    await db.insert(modelPredictionsTable).values(predictionRows);
  }
}