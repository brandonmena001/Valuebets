import { and, eq, gt, gte, inArray, isNull, lt } from "drizzle-orm";
import { db, matchesTable, oddsQuotesTable, priceAnomaliesTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { analyzeMatch, modelProbabilityFor, type Anomaly } from "../model/anomalies";
import { anomalyConfig, modelConfig } from "../model/config";
import { buildMatchSnapshot, type BlendedSnapshot, type HistoryMatch, type QuoteInput } from "../model/predict";

export type AnomalySummary = {
  matches: number;
  detected: number;
  inserted: number;
  updated: number;
  persisted: number;
  expired: number;
  byKind: Record<string, number>;
  byVerdict: Record<string, number>;
};

type Row = typeof priceAnomaliesTable.$inferSelect;

function toValues(matchId: number, a: Anomaly) {
  return {
    matchId,
    kind: a.kind,
    bookmaker: a.bookmaker,
    marketCategory: a.marketCategory,
    marketName: a.marketName,
    selection: a.selection,
    selectionKey: a.selectionKey,
    line: a.line,
    playerName: a.playerName,
    decimalOdds: a.decimalOdds,
    consensusProb: a.consensusProb,
    fairOdds: a.fairOdds,
    referenceBook: a.referenceBook,
    deviationPct: a.deviation === null ? null : a.deviation * 100,
    evPct: a.evPct,
    adjustedEvPct: a.adjustedEvPct,
    booksUsed: a.booksUsed,
    modelAgrees: a.modelAgrees,
    score: a.score,
    verdict: a.verdict,
    voidRisk: a.voidRisk,
    suggestedStakeFraction: a.suggestedStakeFraction,
    reasons: JSON.stringify(a.reasons),
    dataAgeMinutes: a.dataAgeMinutes,
  };
}

/**
 * Detecta alertas de precio en los partidos próximos y las sincroniza con `price_anomalies`:
 * - alerta nueva: se inserta (detected_at fijo, persisted_syncs = 0);
 * - alerta que sigue: se actualiza (last_seen_at) y, si hubo una sincronización nueva de
 *   cuotas desde la última vez, persisted_syncs += 1;
 * - alerta que ya no aparece: se marca expired_at (y si reaparece, se reactiva con persisted_syncs = 0).
 * `history` (opcional) permite consultar al modelo; sin él, model_agrees queda en null.
 */
export async function refreshPriceAnomalies(opts: { history?: HistoryMatch[]; now?: Date } = {}): Promise<AnomalySummary> {
  const now = opts.now ?? new Date();
  const cfg = anomalyConfig;
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
        lt(matchesTable.kickoff, new Date(now.getTime() + cfg.horizonMs)),
      ),
    );

  const quotesByMatch = new Map<number, QuoteInput[]>();
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
          gte(oddsQuotesTable.capturedAt, new Date(now.getTime() - cfg.loadAgeMs)),
        ),
      );
    for (const q of quotes) {
      const list = quotesByMatch.get(q.matchId);
      if (list) list.push(q);
      else quotesByMatch.set(q.matchId, [q]);
    }
  }

  const detected: Array<{ matchId: number; anomaly: Anomaly }> = [];
  for (const match of upcoming) {
    const quotes = quotesByMatch.get(match.id);
    if (!quotes?.length) continue;
    let blended: BlendedSnapshot | null | undefined; // el modelo es caro: solo se consulta si hay hallazgos
    const modelProb = opts.history
      ? (c: Parameters<typeof modelProbabilityFor>[1]) => {
          if (blended === undefined) {
            try {
              blended = buildMatchSnapshot({ history: opts.history!, match, now, quotes })?.blended ?? null;
            } catch (err) {
              logger.warn({ err, matchId: match.id }, "Could not build match snapshot for price anomalies");
              blended = null;
            }
          }
          return modelProbabilityFor(blended, c);
        }
      : undefined;
    for (const anomaly of analyzeMatch({ matchId: match.id, match, quotes, now, modelProb })) {
      detected.push({ matchId: match.id, anomaly });
    }
  }

  // Llaves duplicadas dentro de una misma corrida: se queda la de mayor puntaje.
  const byKey = new Map<string, { matchId: number; anomaly: Anomaly }>();
  for (const d of detected) {
    const cur = byKey.get(d.anomaly.logKey);
    if (!cur || d.anomaly.score > cur.anomaly.score) byKey.set(d.anomaly.logKey, d);
  }
  const keys = [...byKey.keys()];

  const existing: Row[] = [];
  for (let i = 0; i < keys.length; i += 500) {
    existing.push(...(await db.select().from(priceAnomaliesTable).where(inArray(priceAnomaliesTable.logKey, keys.slice(i, i + 500)))));
  }
  const existingByKey = new Map(existing.map((r) => [r.logKey, r]));
  const active = await db.select().from(priceAnomaliesTable).where(isNull(priceAnomaliesTable.expiredAt));

  const summary: AnomalySummary = {
    matches: upcoming.length, detected: byKey.size, inserted: 0, updated: 0, persisted: 0, expired: 0, byKind: {}, byVerdict: {},
  };
  const toInsert: Array<typeof priceAnomaliesTable.$inferInsert> = [];
  await db.transaction(async (tx) => {
    for (const [key, { matchId, anomaly }] of byKey) {
      summary.byKind[anomaly.kind] = (summary.byKind[anomaly.kind] ?? 0) + 1;
      summary.byVerdict[anomaly.verdict] = (summary.byVerdict[anomaly.verdict] ?? 0) + 1;
      const row = existingByKey.get(key);
      const values = toValues(matchId, anomaly);
      if (!row) {
        toInsert.push({ ...values, logKey: key, detectedAt: now, lastSeenAt: now, persistedSyncs: 0 });
        continue;
      }
      // ¿Hubo una sincronización de cuotas posterior a la última vez que la vimos?
      const newSync = row.expiredAt === null && anomaly.capturedAt.getTime() > row.lastSeenAt.getTime();
      const persistedSyncs = row.expiredAt !== null ? 0 : row.persistedSyncs + (newSync ? 1 : 0);
      if (newSync) summary.persisted += 1;
      await tx
        .update(priceAnomaliesTable)
        .set({ ...values, lastSeenAt: now, expiredAt: null, persistedSyncs })
        .where(eq(priceAnomaliesTable.id, row.id));
      summary.updated += 1;
    }
    for (let i = 0; i < toInsert.length; i += 200) {
      await tx.insert(priceAnomaliesTable).values(toInsert.slice(i, i + 200)).onConflictDoNothing();
    }
    summary.inserted = toInsert.length;

    const gone = active.filter((r) => !byKey.has(r.logKey)).map((r) => r.id);
    for (let i = 0; i < gone.length; i += 500) {
      await tx
        .update(priceAnomaliesTable)
        .set({ expiredAt: now })
        .where(and(inArray(priceAnomaliesTable.id, gone.slice(i, i + 500)), isNull(priceAnomaliesTable.expiredAt)));
    }
    summary.expired = gone.length;
  });

  logger.info(summary, "Price anomalies refreshed");
  return summary;
}
