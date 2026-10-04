import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Resultados y estadísticas de partidos terminados importados de football-data.co.uk
 * (gratuito, sin cuota). Es la fuente principal de historial del modelo porque el plan
 * gratuito de API-Football no da acceso a la temporada actual.
 */
export const historicalResultsTable = pgTable(
  "historical_results",
  {
    id: serial("id").primaryKey(),
    leagueCode: text("league_code").notNull(),
    season: text("season").notNull(),
    matchKey: text("match_key").notNull(),
    kickoff: timestamp("kickoff", { withTimezone: true }).notNull(),
    homeTeam: text("home_team").notNull(),
    awayTeam: text("away_team").notNull(),
    homeScore: integer("home_score").notNull(),
    awayScore: integer("away_score").notNull(),
    homeCorners: integer("home_corners"),
    awayCorners: integer("away_corners"),
    homeYellowCards: integer("home_yellow_cards"),
    awayYellowCards: integer("away_yellow_cards"),
    homeRedCards: integer("home_red_cards"),
    awayRedCards: integer("away_red_cards"),
    homeShotsOnTarget: integer("home_shots_on_target"),
    awayShotsOnTarget: integer("away_shots_on_target"),
    source: text("source").notNull().default("football-data"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("historical_results_key_uq").on(table.leagueCode, table.matchKey),
    index("historical_results_league_kickoff_idx").on(table.leagueCode, table.kickoff),
  ],
);

export type HistoricalResult = typeof historicalResultsTable.$inferSelect;
