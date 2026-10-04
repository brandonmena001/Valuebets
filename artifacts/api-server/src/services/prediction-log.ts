import { and, desc, eq, inArray, isNull, lte, lt, isNotNull, sql } from "drizzle-orm";
import {
  db,
  matchesTable,
  matchStatsTable,
  oddsQuotesTable,
  playerMatchStatsTable,
  predictionLogTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { normalizeName } from "../model/names";
import type { PredictionOutput } from "../model/predict";
import { settleOutcome } from "../model/settle";

function logKey(p: PredictionOutput): string {
  return [
    p.matchId, p.marketCategory, p.selectionKey, p.line ?? "",
    normalizeName(p.playerName ?? ""), p.bookmaker, p.modelVersion,
  ].join("|");
}

/** Guarda la primera recomendación de cada apuesta (precio de apertura). No se sobrescribe. */
export async function recordPredictions(predictions: PredictionOutput[]): Promise<void> {
  for (let i = 0; i < predictions.length; i += 300) {
    const chunk = predictions.slice(i, i + 300).map((p) => ({
      matchId: p.matchId,
      logKey: logKey(p),
      marketCategory: p.marketCategory,
      marketName: p.marketName,
      selection: p.selection,
      selectionKey: p.selectionKey,
      line: p.line,
      playerName: p.playerName,
      bookmaker: p.bookmaker,
      decimalOdds: p.decimalOdds,
      modelProbability: p.modelProbability,
      rawModelProbability: p.rawModelProbability,
      marketProbability: p.marketProbability,
      expectedValuePct: p.expectedValuePct,
      kellyFraction: p.kellyFraction,
      bookmakersCount: p.bookmakersCount,
      confidence: p.confidence,
      modelVersion: p.modelVersion,
    }));
    if (chunk.length) {
      await db.insert(predictionLogTable).values(chunk).onConflictDoNothing({ target: predictionLogTable.logKey });
    }
  }
}

/** Liquida las apuestas registradas de partidos terminados y guarda la cuota de cierre (aprox.). */
export async function settlePredictionLog(): Promise<number> {
  const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000);
  const threeDaysAgo = new Date(Date.now() - 72 * 3_600_000);
  const pending = await db
    .select({
      log: predictionLogTable,
      status: matchesTable.status,
      kickoff: matchesTable.kickoff,
      homeScore: matchesTable.homeScore,
      awayScore: matchesTable.awayScore,
    })
    .from(predictionLogTable)
    .innerJoin(matchesTable, eq(predictionLogTable.matchId, matchesTable.id))
    .where(and(isNull(predictionLogTable.outcome), lt(matchesTable.kickoff, threeHoursAgo)));
  if (!pending.length) return 0;

  const matchIds = [...new Set(pending.map((row) => row.log.matchId))];
  const statRows = await db.select().from(matchStatsTable).where(inArray(matchStatsTable.matchId, matchIds));
  const statsByMatch = new Map(statRows.map((row) => [row.matchId, row]));
  const playerRows = await db
    .select()
    .from(playerMatchStatsTable)
    .where(inArray(playerMatchStatsTable.matchId, matchIds));

  let settled = 0;
  for (const row of pending) {
    const { log } = row;
    let outcome: "win" | "loss" | "void" | null = null;
    if ((row.status === "cancelled" || row.status === "postponed") && row.kickoff < threeDaysAgo) {
      outcome = "void";
    } else if (row.status === "finished" && row.homeScore != null && row.awayScore != null) {
      const target = normalizeName(log.playerName ?? "");
      const lastName = target.split(" ").at(-1);
      const candidates = log.playerName
        ? playerRows.filter((p) => p.matchId === log.matchId && normalizeName(p.playerName) === target)
        : [];
      const fallback =
        log.playerName && !candidates.length
          ? playerRows.filter(
              (p) =>
                p.matchId === log.matchId &&
                normalizeName(p.playerName).split(" ").at(-1) === lastName &&
                normalizeName(p.playerName).charAt(0) === target.charAt(0),
            )
          : [];
      const player = candidates.length === 1 ? candidates[0] : fallback.length === 1 ? fallback[0] : undefined;
      outcome = settleOutcome({
        marketCategory: log.marketCategory,
        selectionKey: log.selectionKey,
        line: log.line,
        playerName: log.playerName,
        homeScore: row.homeScore,
        awayScore: row.awayScore,
        stats: statsByMatch.get(log.matchId) ?? null,
        playerShots: player?.shotsOnTarget ?? null,
      });
    }
    if (!outcome) continue;

    const [closing] = await db
      .select({ odds: oddsQuotesTable.decimalOdds })
      .from(oddsQuotesTable)
      .where(
        and(
          eq(oddsQuotesTable.matchId, log.matchId),
          eq(oddsQuotesTable.bookmaker, log.bookmaker),
          eq(oddsQuotesTable.marketName, log.marketName),
          eq(oddsQuotesTable.selection, log.selection),
          log.line == null ? isNull(oddsQuotesTable.line) : eq(oddsQuotesTable.line, log.line),
          log.playerName == null
            ? isNull(oddsQuotesTable.playerName)
            : eq(oddsQuotesTable.playerName, log.playerName),
          lte(oddsQuotesTable.capturedAt, row.kickoff),
        ),
      )
      .orderBy(desc(oddsQuotesTable.capturedAt))
      .limit(1);

    await db
      .update(predictionLogTable)
      .set({ outcome, settledAt: new Date(), closingOdds: closing?.odds ?? null })
      .where(eq(predictionLogTable.id, log.id));
    settled += 1;
  }
  logger.info({ settled, pending: pending.length }, "Prediction log settled");
  return settled;
}

type Bucket = {
  bets: number;
  wins: number;
  hitRatePct: number | null;
  roiPct: number | null;
  roiStdErrPct: number | null;
  avgClvPct: number | null;
  avgOdds: number | null;
  brierModel: number | null;
  brierRaw: number | null;
  brierMarket: number | null;
};

function summarize(
  rows: Array<typeof predictionLogTable.$inferSelect>,
): Bucket {
  const n = rows.length;
  if (!n) {
    return {
      bets: 0, wins: 0, hitRatePct: null, roiPct: null, roiStdErrPct: null,
      avgClvPct: null, avgOdds: null, brierModel: null, brierRaw: null, brierMarket: null,
    };
  }
  const wins = rows.filter((r) => r.outcome === "win").length;
  const returns = rows.map((r) => (r.outcome === "win" ? r.decimalOdds - 1 : -1));
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const clv = rows.filter((r) => r.closingOdds && r.closingOdds > 1).map((r) => r.decimalOdds / r.closingOdds! - 1);
  const brier = (pick: (r: (typeof rows)[number]) => number) =>
    rows.reduce((a, r) => a + (pick(r) - (r.outcome === "win" ? 1 : 0)) ** 2, 0) / n;
  return {
    bets: n,
    wins,
    hitRatePct: (wins / n) * 100,
    roiPct: mean * 100,
    roiStdErrPct: n > 1 ? (Math.sqrt(variance / n)) * 100 : null,
    avgClvPct: clv.length ? (clv.reduce((a, b) => a + b, 0) / clv.length) * 100 : null,
    avgOdds: rows.reduce((a, r) => a + r.decimalOdds, 0) / n,
    brierModel: brier((r) => r.modelProbability),
    brierRaw: brier((r) => r.rawModelProbability),
    brierMarket: brier((r) => r.marketProbability),
  };
}

export async function getModelPerformance() {
  const rows = await db
    .select()
    .from(predictionLogTable)
    .where(and(isNotNull(predictionLogTable.outcome)));
  const settled = rows.filter((r) => r.outcome === "win" || r.outcome === "loss");
  const [pendingRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(predictionLogTable)
    .where(isNull(predictionLogTable.outcome));
  const byMarket: Record<string, Bucket> = {};
  for (const category of [...new Set(settled.map((r) => r.marketCategory))]) {
    byMarket[category] = summarize(settled.filter((r) => r.marketCategory === category));
  }
  const overall = summarize(settled);
  return {
    generatedAt: new Date().toISOString(),
    pending: pendingRow?.count ?? 0,
    overall,
    byMarket,
    reliability:
      overall.bets < 300
        ? `Muestra insuficiente (${overall.bets} apuestas liquidadas). Con menos de ~300 apuestas el ROI no es estadísticamente distinguible de la suerte; guíate por el CLV y el Brier mientras tanto.`
        : "Muestra suficiente para una primera lectura; compara el ROI con su error estándar.",
  };
}
