function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export const MODEL_VERSION = "dc-nb-market-blend-v2";

/**
 * Todos los umbrales son ajustables por variable de entorno sin tocar código.
 * Los valores por defecto son deliberadamente conservadores.
 */
export const modelConfig = {
  // --- Ajuste de fuerza de equipos ---
  halfLifeDays: num("MODEL_HALF_LIFE_DAYS", 180),
  priorGames: num("MODEL_PRIOR_GAMES", 5),
  minLeagueMatches: num("MODEL_MIN_LEAGUE_MATCHES", 40),
  minTeamEss: num("MODEL_MIN_TEAM_ESS", 5),

  // --- Calidad de los datos de cuotas ---
  maxOddsAgeMs: num("MODEL_MAX_ODDS_AGE_HOURS", 9) * 3_600_000,
  minLeadMs: num("MODEL_MIN_LEAD_MINUTES", 20) * 60_000,
  minBookmakers: num("MODEL_MIN_BOOKMAKERS", 3),
  minBookmakersProps: num("MODEL_MIN_BOOKMAKERS_PROPS", 2),

  // --- Filtros de la apuesta ---
  minEvPct: num("MODEL_MIN_EV_PCT", 4),
  maxEvPct: num("MODEL_MAX_EV_PCT", 20),
  maxMarketEvPct: num("MODEL_MAX_MARKET_EV_PCT", 10),
  maxModelMarketGap: num("MODEL_MAX_GAP", 0.08),
  minOdds: num("MODEL_MIN_ODDS", 1.2),
  maxOdds: num("MODEL_MAX_ODDS", 6),

  // --- Gestión de banca (Kelly fraccional con tope) ---
  kellyFraction: num("MODEL_KELLY_FRACTION", 0.25),
  maxStakeFraction: num("MODEL_MAX_STAKE", 0.02),
};

/**
 * Peso máximo del modelo frente al consenso del mercado (el resto es mercado).
 * El mercado 1X2 es el más eficiente, por eso el modelo pesa menos ahí.
 */
export const maxModelWeight = {
  "match-result": 0.35,
  goals: 0.4,
  corners: 0.45,
  cards: 0.4,
  "shots-on-target": 0.45,
  player: 0.3,
} as const;

/** Cuántos "partidos efectivos" hacen falta para alcanzar la mitad del peso máximo. */
export const ESS_HALF_WEIGHT = 8;
