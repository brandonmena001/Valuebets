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
import { matchesTable } from "./matches";

export const oddsQuotesTable = pgTable(
  "odds_quotes",
  {
    id: serial("id").primaryKey(),
    matchId: integer("match_id")
      .notNull()
      .references(() => matchesTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    upstreamBookmakerId: text("upstream_bookmaker_id"),
    bookmaker: text("bookmaker").notNull(),
    upstreamMarketId: text("upstream_market_id"),
    marketCategory: text("market_category").notNull(),
    marketName: text("market_name").notNull(),
    selection: text("selection").notNull(),
    playerName: text("player_name"),
    line: doublePrecision("line"),
    decimalOdds: doublePrecision("decimal_odds").notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    fingerprint: text("fingerprint").notNull(),
  },
  (table) => [
    uniqueIndex("odds_quotes_fingerprint_uq").on(table.fingerprint),
    uniqueIndex("odds_quotes_match_source_market_idx").on(
      table.matchId,
      table.provider,
      table.bookmaker,
      table.upstreamMarketId,
      table.selection,
      table.line,
      table.sourceUpdatedAt,
    ),
  ],
);

export const insertOddsQuoteSchema = createInsertSchema(oddsQuotesTable).omit({
  id: true,
  capturedAt: true,
});

export type InsertOddsQuote = z.infer<typeof insertOddsQuoteSchema>;
export type OddsQuote = typeof oddsQuotesTable.$inferSelect;