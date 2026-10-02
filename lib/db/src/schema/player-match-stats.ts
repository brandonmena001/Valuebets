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

export const playerMatchStatsTable = pgTable(
  "player_match_stats",
  {
    id: serial("id").primaryKey(),
    matchId: integer("match_id")
      .notNull()
      .references(() => matchesTable.id, { onDelete: "cascade" }),
    playerApiId: integer("player_api_id").notNull(),
    playerName: text("player_name").notNull(),
    teamApiId: integer("team_api_id"),
    minutesPlayed: integer("minutes_played"),
    shotsOnTarget: integer("shots_on_target"),
    source: text("source").notNull().default("api-football"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("player_match_stats_match_player_uq").on(
      table.matchId,
      table.playerApiId,
    ),
  ],
);

export const insertPlayerMatchStatsSchema = createInsertSchema(
  playerMatchStatsTable,
).omit({
  id: true,
  updatedAt: true,
});

export type InsertPlayerMatchStats = z.infer<
  typeof insertPlayerMatchStatsSchema
>;
export type PlayerMatchStats = typeof playerMatchStatsTable.$inferSelect;