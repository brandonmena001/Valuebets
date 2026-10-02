import { createInsertSchema } from "drizzle-zod";
import {
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const providerTournamentsTable = pgTable(
  "provider_tournaments",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull(),
    leagueCode: text("league_code").notNull(),
    upstreamTournamentId: text("upstream_tournament_id").notNull(),
    tournamentName: text("tournament_name").notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_tournaments_provider_league_uq").on(
      table.provider,
      table.leagueCode,
    ),
  ],
);

export const insertProviderTournamentSchema = createInsertSchema(
  providerTournamentsTable,
).omit({
  id: true,
  lastCheckedAt: true,
});

export type InsertProviderTournament = z.infer<
  typeof insertProviderTournamentSchema
>;
export type ProviderTournament = typeof providerTournamentsTable.$inferSelect;