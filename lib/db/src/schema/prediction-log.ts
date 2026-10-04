import {
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
 * Registro histórico (solo inserciones) de cada value bet recomendada.
 * Se guarda la PRIMERA vez que se recomienda (precio de apertura) y se liquida
 * cuando el partido termina. Es la base para medir ROI, CLV y calibración reales.
 */
export const predictionLogTable = pgTable(
  "prediction_log",
  {
    id: serial("id").primaryKey(),
    matchId: integer("match_id")
      .notNull()
      .references(() => matchesTable.id, { onDelete: "cascade" }),
    logKey: text("log_key").notNull(),
    marketCategory: text("market_category").notNull(),
    marketName: text("market_name").notNull(),
    selection: text("selection").notNull(),
    selectionKey: text("selection_key").notNull(),
    line: doublePrecision("line"),
    playerName: text("player_name"),
    bookmaker: text("bookmaker").notNull(),
    decimalOdds: doublePrecision("decimal_odds").notNull(),
    modelProbability: doublePrecision("model_probability").notNull(),
    rawModelProbability: doublePrecision("raw_model_probability").notNull(),
    marketProbability: doublePrecision("market_probability").notNull(),
    expectedValuePct: doublePrecision("expected_value_pct").notNull(),
    kellyFraction: doublePrecision("kelly_fraction").notNull(),
    bookmakersCount: integer("bookmakers_count").notNull(),
    confidence: text("confidence").notNull(),
    modelVersion: text("model_version").notNull(),
    loggedAt: timestamp("logged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    outcome: text("outcome"),
    closingOdds: doublePrecision("closing_odds"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("prediction_log_key_uq").on(table.logKey),
    index("prediction_log_outcome_idx").on(table.outcome),
    index("prediction_log_match_idx").on(table.matchId),
  ],
);

export type PredictionLog = typeof predictionLogTable.$inferSelect;
export type InsertPredictionLog = typeof predictionLogTable.$inferInsert;
