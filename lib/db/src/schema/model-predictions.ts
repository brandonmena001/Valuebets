import { createInsertSchema } from "drizzle-zod";
import {
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { oddsQuotesTable } from "./odds";

export const modelPredictionsTable = pgTable(
  "model_predictions",
  {
    id: serial("id").primaryKey(),
    oddsQuoteId: integer("odds_quote_id")
      .notNull()
      .references(() => oddsQuotesTable.id, { onDelete: "cascade" }),
    modelProbability: doublePrecision("model_probability").notNull(),
    fairOdds: doublePrecision("fair_odds").notNull(),
    expectedValuePct: doublePrecision("expected_value_pct").notNull(),
    modelVersion: text("model_version").notNull(),
    sampleSize: integer("sample_size").notNull(),
    confidence: text("confidence").notNull(),
    rawModelProbability: doublePrecision("raw_model_probability"),
    marketProbability: doublePrecision("market_probability"),
    kellyFraction: doublePrecision("kelly_fraction"),
    bookmakersCount: integer("bookmakers_count"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("model_predictions_odds_quote_uq").on(table.oddsQuoteId),
  ],
);

export const insertModelPredictionSchema = createInsertSchema(
  modelPredictionsTable,
).omit({
  id: true,
  createdAt: true,
});

export type InsertModelPrediction = z.infer<typeof insertModelPredictionSchema>;
export type ModelPrediction = typeof modelPredictionsTable.$inferSelect;