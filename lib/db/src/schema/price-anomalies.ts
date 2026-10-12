import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { matchesTable } from "./matches";

/**
 * Alertas de precio: errores de cuota y cuotas anormalmente altas entre casas.
 * Una fila por alerta (log_key único). Se actualiza en cada sincronización
 * (last_seen_at, persisted_syncs) y se marca expired_at cuando deja de aparecer.
 * Contrato completo en docs/contrato-alertas.md.
 */
export const priceAnomaliesTable = pgTable(
  "price_anomalies",
  {
    id: serial("id").primaryKey(),
    matchId: integer("match_id")
      .notNull()
      .references(() => matchesTable.id, { onDelete: "cascade" }),
    /** matchId|casa|mercado|selección|línea|jugador|kind */
    logKey: text("log_key").notNull(),
    /** high-price | arbitrage | inconsistent-line | swapped-selection | invalid-odds | stale-line */
    kind: text("kind").notNull(),
    bookmaker: text("bookmaker").notNull(),
    marketCategory: text("market_category").notNull(),
    marketName: text("market_name").notNull(),
    selection: text("selection").notNull(),
    selectionKey: text("selection_key").notNull(),
    line: doublePrecision("line"),
    playerName: text("player_name"),
    decimalOdds: doublePrecision("decimal_odds").notNull(),
    consensusProb: doublePrecision("consensus_prob"),
    fairOdds: doublePrecision("fair_odds"),
    referenceBook: text("reference_book"),
    deviationPct: doublePrecision("deviation_pct"),
    evPct: doublePrecision("ev_pct"),
    adjustedEvPct: doublePrecision("adjusted_ev_pct"),
    booksUsed: integer("books_used").notNull(),
    modelAgrees: boolean("model_agrees"),
    /** Entero de 0 a 100. */
    score: integer("score").notNull(),
    /** tomar | vigilar | descartar */
    verdict: text("verdict").notNull(),
    /** bajo | medio | alto */
    voidRisk: text("void_risk").notNull(),
    suggestedStakeFraction: doublePrecision("suggested_stake_fraction"),
    /** Arreglo JSON de frases en español. */
    reasons: text("reasons").notNull(),
    dataAgeMinutes: integer("data_age_minutes").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    /** Sincronizaciones posteriores a la detección en las que la alerta siguió apareciendo. */
    persistedSyncs: integer("persisted_syncs").notNull().default(0),
  },
  (table) => [
    uniqueIndex("price_anomalies_key_uq").on(table.logKey),
    index("price_anomalies_match_idx").on(table.matchId),
    index("price_anomalies_active_idx").on(table.expiredAt, table.score),
    index("price_anomalies_verdict_idx").on(table.verdict),
  ],
);

export type PriceAnomaly = typeof priceAnomaliesTable.$inferSelect;
export type InsertPriceAnomaly = typeof priceAnomaliesTable.$inferInsert;
