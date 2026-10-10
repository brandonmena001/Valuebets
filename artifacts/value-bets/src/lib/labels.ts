export const leagues: Record<string, string> = {
  'premier-league': 'Premier League',
  'la-liga': 'LaLiga',
  bundesliga: 'Bundesliga',
};

export const marketNames: Record<string, string> = {
  'match-result': '1X2',
  goals: 'Goles',
  corners: 'Córners',
  cards: 'Tarjetas',
  'shots-on-target': 'Tiros a puerta',
};

export const providerNames: Record<string, string> = {
  'api-football': 'API-Football',
  oddspapi: 'OddsPapi',
  'football-data': 'Football-Data',
};

/** Siglas para el icono de cada proveedor. */
export const providerBadges: Record<string, string> = {
  'api-football': 'AF',
  oddspapi: 'OP',
  'football-data': 'FD',
};

export const providerRoles: Record<string, string> = {
  'api-football': 'fixtures y estadísticas',
  oddspapi: 'cuotas',
  'football-data': 'historial de resultados',
};

/** Proveedores que la pantalla Fuentes siempre muestra, aunque la API aún no informe de alguno. */
export const knownProviders = ['api-football', 'oddspapi', 'football-data'] as const;

export const statusNames: Record<string, string> = {
  scheduled: 'Programado',
  live: 'En directo',
  finished: 'Finalizado',
  postponed: 'Aplazado',
  cancelled: 'Cancelado',
  unknown: 'Sin estado',
  ok: 'Operativo',
  partial: 'Cobertura parcial',
  stale: 'Datos desactualizados',
  waiting: 'En espera',
  error: 'Error',
  unconfigured: 'Sin configurar',
};

export const confidenceNames = { high: 'Alta', medium: 'Media', low: 'Baja' } as const;
