import { createInsertSchema } from "drizzle-zod";
import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const matchesTable = pgTable(
  "matches",
  {
    id: serial("id").primaryKey(),
    apiFootballFixtureId: integer("api_football_fixture_id"),
    oddsPapiFixtureId: text("oddspapi_fixture_id"),
    leagueCode: text("league_code").notNull(),
    leagueName: text("league_name").notNull(),
    country: text("country").notNull(),
    homeTeamApiId: integer("home_team_api_id"),
    awayTeamApiId: integer("away_team_api_id"),
    homeTeam: text("home_team").notNull(),
    awayTeam: text("away_team").notNull(),
    kickoff: timestamp("kickoff", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("scheduled"),
    homeScore: integer("home_score"),
    awayScore: integer("away_score"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("matches_api_football_fixture_id_uq").on(
      table.apiFootballFixtureId,
    ),
    uniqueIndex("matches_oddspapi_fixture_id_uq").on(table.oddsPapiFixtureId),
    index("matches_league_kickoff_idx").on(table.leagueCode, table.kickoff),
    index("matches_status_kickoff_idx").on(table.status, table.kickoff),
  ],
);

export const insertMatchSchema = createInsertSchema(matchesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertMatch = z.infer<typeof insertMatchSchema>;
export type Match = typeof matchesTable.$inferSelect;