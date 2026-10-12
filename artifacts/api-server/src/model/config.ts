function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
}

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
  // El colector sincroniza OddsPapi cada 7–13 h según la cuota restante; con 9 h las cuotas caducarían antes de la siguiente sincronización.
  maxOddsAgeMs: num("MODEL_MAX_ODDS_AGE_HOURS", 14) * 3_600_000,
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

/**
 * Detección de errores de cuota y cuotas altas (alertas de precio). Todo ajustable por
 * variables ANOMALY_*. Los valores iniciales son los del plan y NO están calibrados con datos reales.
 */
export const anomalyConfig = {
  // --- Consenso leave-one-out ---
  /** Casas con el mercado completo (incluida la evaluada) para generar high-price. */
  minBooks: num("ANOMALY_MIN_BOOKS", 4),
  /** Mínimo si alguna de las otras casas es de referencia aguda. */
  minBooksSharp: num("ANOMALY_MIN_BOOKS_SHARP", 2),
  /** Casas de referencia aguda (coincidencia por nombre, separadas por coma). */
  referenceBooks: str("ANOMALY_REFERENCE_BOOKS", "pinnacle")
    .toLowerCase()
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),

  // --- Desviación (cuota / cuota justa - 1) ---
  highDeviation: num("ANOMALY_HIGH_DEVIATION", 0.06),
  errorDeviation: num("ANOMALY_ERROR_DEVIATION", 0.15),
  voidMediumDeviation: num("ANOMALY_VOID_MEDIUM_DEVIATION", 0.15),
  voidHighDeviation: num("ANOMALY_VOID_HIGH_DEVIATION", 0.25),
  /** Probabilidad supuesta de que la casa anule la apuesta. */
  voidProbLow: num("ANOMALY_VOID_PROB_LOW", 0.02),
  voidProbMedium: num("ANOMALY_VOID_PROB_MEDIUM", 0.15),
  voidProbHigh: num("ANOMALY_VOID_PROB_HIGH", 0.5),

  // --- Señales estructurales ---
  arbMinMargin: num("ANOMALY_ARB_MIN_MARGIN", 0.003),
  invalidMinOdds: num("ANOMALY_INVALID_MIN_ODDS", 1.01),
  invalidMaxOdds: num("ANOMALY_INVALID_MAX_ODDS", 500),
  invalidMinImpliedSum: num("ANOMALY_INVALID_MIN_IMPLIED_SUM", 0.97),
  /** Diferencia de probabilidad tolerada entre líneas contiguas de una misma casa. */
  lineTolerance: num("ANOMALY_LINE_TOLERANCE", 0.02),
  swapMinDistance: num("ANOMALY_SWAP_MIN_DISTANCE", 0.2),
  swapRatio: num("ANOMALY_SWAP_RATIO", 0.35),
  staleGapMinutes: num("ANOMALY_STALE_GAP_MINUTES", 360),
  staleMinOthers: num("ANOMALY_STALE_MIN_OTHERS", 2),

  // --- Puntaje (0-100) ---
  wDev: num("ANOMALY_W_DEV", 35),
  wConf: num("ANOMALY_W_CONF", 20),
  wAgree: num("ANOMALY_W_AGREE", 15),
  wFresh: num("ANOMALY_W_FRESH", 15),
  wLiq: num("ANOMALY_W_LIQ", 10),
  wBonus: num("ANOMALY_W_BONUS", 5),
  devFullHighPrice: num("ANOMALY_DEV_FULL", 0.2),
  devFullArbitrage: num("ANOMALY_ARB_DEV_FULL", 0.03),
  confFullBooks: num("ANOMALY_CONF_FULL_BOOKS", 8),
  freshFullMinutes: num("ANOMALY_FRESH_FULL_MINUTES", 180),
  freshZeroMinutes: num("ANOMALY_FRESH_ZERO_MINUTES", 540),
  liqCore: num("ANOMALY_LIQ_CORE", 1),
  liqSecondary: num("ANOMALY_LIQ_SECONDARY", 0.6),
  liqProps: num("ANOMALY_LIQ_PROPS", 0.3),
  bonusStructural: num("ANOMALY_BONUS_STRUCTURAL", 1),
  bonusHighPrice: num("ANOMALY_BONUS_HIGH_PRICE", 0.5),

  // --- Veredicto y apuesta ---
  takeMinScore: num("ANOMALY_TAKE_MIN_SCORE", 70),
  takeMaxAgeMinutes: num("ANOMALY_TAKE_MAX_AGE_MINUTES", 180),
  takeMinAdjustedEvPct: num("ANOMALY_TAKE_MIN_ADJ_EV_PCT", 3),
  discardMaxScore: num("ANOMALY_DISCARD_BELOW_SCORE", 40),
  discardAgeMinutes: num("ANOMALY_DISCARD_AGE_MINUTES", 540),
  kellyFraction: num("ANOMALY_KELLY_FRACTION", modelConfig.kellyFraction),
  maxStakeFraction: num("ANOMALY_MAX_STAKE", modelConfig.maxStakeFraction),
  maxStakeFractionHighVoid: num("ANOMALY_MAX_STAKE_HIGH_VOID", 0.005),

  // --- Servicio ---
  /** Edad máxima de las cuotas que se leen (las más viejas que el límite de "tomar" salen como vigilar/descartar). */
  loadAgeMs: num("ANOMALY_LOAD_AGE_HOURS", 14) * 3_600_000,
  horizonMs: num("ANOMALY_HORIZON_DAYS", 10) * 86_400_000,
};
