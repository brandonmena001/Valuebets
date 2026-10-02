import { createInsertSchema } from "drizzle-zod";
import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { matchesTable } from "./matches";

export const matchStatsTable = pgTable(
  "match_stats",
  {
    id: serial("id").primaryKey(),
    matchId: integer("match_id")
      .notNull()
      .references(() => matchesTable.id, { onDelete: "cascade" }),
    homeCorners: integer("home_corners"),
    awayCorners: integer("away_corners"),
    homeYellowCards: integer("home_yellow_cards"),
    awayYellowCards: integer("away_yellow_cards"),
    homeRedCards: integer("home_red_cards"),
    awayRedCards: integer("away_red_cards"),
    homeShotsOnTarget: integer("home_shots_on_target"),
    awayShotsOnTarget: integer("away_shots_on_target"),
    source: text("source").notNull().default("api-football"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("match_stats_match_id_uq").on(table.matchId)],
);

export const insertMatchStatsSchema = createInsertSchema(matchStatsTable).omit({
  id: true,
  updatedAt: true,
});

export type InsertMatchStats = z.infer<typeof insertMatchStatsSchema>;
export type MatchStats = typeof matchStatsTable.$inferSelect;