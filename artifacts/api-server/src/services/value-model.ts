import { and, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import {
  db,
  historicalResultsTable,
  matchesTable,
  matchStatsTable,
  modelPredictionsTable,
  oddsQuotesTable,
  playerMatchStatsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { modelConfig } from "../model/config";
import { buildPredictions, newDiagnostics, type HistoryMatch, type PlayerGame, type QuoteInput } from "../model/predict";
import { refreshPriceAnomalies } from "./anomalies";
import { recordPredictions, settlePredictionLog } from "./prediction-log";

const HORIZON_MS = 10 * 24 * 3_600_000;
const PLAYER_HISTORY_MS = 540 * 24 * 3_600_000;

export async function loadFinishedHistory(now: Date): Promise<HistoryMatch[]> {
  const rows = await db
    .select({
      id: matchesTable.id,
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
    .where(and(eq(matchesTable.status, "finished"), lt(matchesTable.kickoff, now)));

  // football-data.co.uk es la fuente principal; los terminados de `matches` solo se usan
  // en ligas sin historial importado (el plan gratuito de API-Football no cubre la temporada actual).
  const imported = await db.select().from(historicalResultsTable).where(lt(historicalResultsTable.kickoff, now));
  const covered = new Set(imported.map((row) => row.leagueCode));
  const fromImport: HistoryMatch[] = imported.map((row) => ({
    id: -row.id,
    leagueCode: row.leagueCode,
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    kickoff: row.kickoff,
    homeScore: row.homeScore,
    awayScore: row.awayScore,
    homeCorners: row.homeCorners,
    awayCorners: row.awayCorners,
    homeYellowCards: row.homeYellowCards,
    awayYellowCards: row.awayYellowCards,
    homeRedCards: row.homeRedCards,
    awayRedCards: row.awayRedCards,
    homeShotsOnTarget: row.homeShotsOnTarget,
    awayShotsOnTarget: row.awayShotsOnTarget,
  }));
  return [...fromImport, ...rows.filter((row) => !covered.has(row.leagueCode))];
}

/**
 * Recalcula las value bets. Modelo: Dixon-Coles con decaimiento temporal para goles/1X2,
 * binomial negativa para córners/tarjetas/tiros, y mezcla con el consenso de mercado
 * (sin margen) como ancla. Ver /model/* para la lógica pura y sus tests.
 */
export async function refreshModelPredictions(): Promise<void> {
  const now = new Date();
  try {
    await settlePredictionLog();
  } catch (err) {
    logger.warn({ err }, "Could not settle prediction log");
  }

  const history = await loadFinishedHistory(now);

  const upcoming = await db
    .select({
      id: matchesTable.id,
      leagueCode: matchesTable.leagueCode,
      homeTeam: matchesTable.homeTeam,
      awayTeam: matchesTable.awayTeam,
      kickoff: matchesTable.kickoff,
    })
    .from(matchesTable)
    .where(
      and(
        eq(matchesTable.status, "scheduled"),
        gt(matchesTable.kickoff, new Date(now.getTime() + modelConfig.minLeadMs)),
        lt(matchesTable.kickoff, new Date(now.getTime() + HORIZON_MS)),
      ),
    );

  let predictions: ReturnType<typeof buildPredictions> = [];
  if (upcoming.length) {
    const quotes: QuoteInput[] = await db
      .select({
        id: oddsQuotesTable.id,
        matchId: oddsQuotesTable.matchId,
        bookmaker: oddsQuotesTable.bookmaker,
        upstreamMarketId: oddsQuotesTable.upstreamMarketId,
        marketCategory: oddsQuotesTable.marketCategory,
        marketName: oddsQuotesTable.marketName,
        selection: oddsQuotesTable.selection,
        playerName: oddsQuotesTable.playerName,
        line: oddsQuotesTable.line,
        decimalOdds: oddsQuotesTable.decimalOdds,
        capturedAt: oddsQuotesTable.capturedAt,
        sourceUpdatedAt: oddsQuotesTable.sourceUpdatedAt,
      })
      .from(oddsQuotesTable)
      .where(
        and(
          inArray(oddsQuotesTable.matchId, upcoming.map((m) => m.id)),
          gte(oddsQuotesTable.capturedAt, new Date(now.getTime() - modelConfig.maxOddsAgeMs)),
        ),
      );

    const hasPlayerProps = quotes.some((q) => q.marketCategory === "shots-on-target" && q.playerName);
    const playerGames: PlayerGame[] = hasPlayerProps
      ? await db
          .select({
            playerName: playerMatchStatsTable.playerName,
            kickoff: matchesTable.kickoff,
            minutes: playerMatchStatsTable.minutesPlayed,
            shots: playerMatchStatsTable.shotsOnTarget,
          })
          .from(playerMatchStatsTable)
          .innerJoin(matchesTable, eq(playerMatchStatsTable.matchId, matchesTable.id))
          .where(gte(matchesTable.kickoff, new Date(now.getTime() - PLAYER_HISTORY_MS)))
      : [];

    const diagnostics = newDiagnostics();
    predictions = buildPredictions({ history, playerGames, matches: upcoming, quotes, now, diagnostics });

    // Edad real de las cuotas guardadas de estos partidos (las que ya caducaron no entran a `quotes`).
    const freshSince = new Date(now.getTime() - modelConfig.maxOddsAgeMs);
    const [ages] = await db
      .select({
        total: sql<number>`count(*)::int`,
        fresh: sql<number>`(count(*) filter (where ${oddsQuotesTable.capturedAt} >= ${freshSince.toISOString()}::timestamptz))::int`,
        newest: sql<string | null>`max(${oddsQuotesTable.capturedAt})`,
      })
      .from(oddsQuotesTable)
      .where(inArray(oddsQuotesTable.matchId, upcoming.map((m) => m.id)));
    const newest = ages?.newest ? new Date(ages.newest) : null;
    const topUnsupported = Object.entries(diagnostics.unsupportedMarkets)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([market, count]) => `${market} (${count})`);
    logger.info(
      {
        maxOddsAgeHours: modelConfig.maxOddsAgeMs / 3_600_000,
        quotesStored: ages?.total ?? 0,
        quotesFresh: ages?.fresh ?? 0,
        newestQuoteAgeHours: newest ? Math.round(((now.getTime() - newest.getTime()) / 3_600_000) * 10) / 10 : null,
        funnel: diagnostics.counters,
        bookmakersPerSelection: diagnostics.bookmakersSeen,
        topUnsupportedMarkets: topUnsupported,
      },
      "Model funnel",
    );
  }

  await db.transaction(async (tx) => {
    await tx.delete(modelPredictionsTable);
    for (let i = 0; i < predictions.length; i += 300) {
      await tx.insert(modelPredictionsTable).values(
        predictions.slice(i, i + 300).map((p) => ({
          oddsQuoteId: p.oddsQuoteId,
          modelProbability: p.modelProbability,
          fairOdds: p.fairOdds,
          expectedValuePct: p.expectedValuePct,
          modelVersion: p.modelVersion,
          sampleSize: p.sampleSize,
          confidence: p.confidence,
          rawModelProbability: p.rawModelProbability,
          marketProbability: p.marketProbability,
          kellyFraction: p.kellyFraction,
          bookmakersCount: p.bookmakersCount,
        })),
      );
    }
  });
  await recordPredictions(predictions);
  logger.info(
    { predictions: predictions.length, history: history.length, upcoming: upcoming.length },
    "Model predictions refreshed",
  );

  // Alertas de precio: un fallo aquí nunca debe afectar a las value bets.
  try {
    await refreshPriceAnomalies({ history, now });
  } catch (err) {
    logger.warn({ err }, "Could not refresh price anomalies");
  }
}
