import { createHash } from "node:crypto";

export const ODDS_NEAR_HOURS = 24;
export const ODDS_FAR_HOURS = 48;
export const ODDS_FAR_ONLY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const ODDS_DISCOVERY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HOUR = 3_600_000;

export type CalendarMatch = { leagueCode: string; kickoff: Date };

export type OddsPlan = {
  fetch: boolean;
  /** Ligas cuyos torneos se piden (solo las que tienen partidos en la ventana). */
  leagues: string[];
  reason: string;
  near: number;
  far: number;
};

/**
 * Decide si una sincronización de cuotas debe gastar llamadas de OddsPapi.
 * - Partidos en las próximas 24 h: se consulta (el temporizador ya espacia 8 h).
 * - Solo partidos entre 24 y 48 h: máximo una consulta cada 24 h (programada).
 * - Ninguno y calendario conocido: 0 llamadas.
 * - Calendario desconocido (sin fixtures.csv ni partidos en BD): una consulta de
 *   descubrimiento como máximo cada 24 h si es programada; la manual siempre pasa.
 * Una sincronización manual salta los límites de cadencia, no el filtro de ligas.
 */
export function planOddsFetch(input: {
  calendar: CalendarMatch[];
  calendarKnown: boolean;
  allLeagues: string[];
  now: Date;
  lastFetchAt: number;
  lastDiscoveryAt: number;
  scheduled: boolean;
}): OddsPlan {
  const t = input.now.getTime();
  const near = new Set<string>();
  const far = new Set<string>();
  let nearCount = 0;
  let farCount = 0;
  for (const match of input.calendar) {
    const ahead = match.kickoff.getTime() - t;
    if (ahead < -2 * HOUR || ahead > ODDS_FAR_HOURS * HOUR) continue;
    if (!input.allLeagues.includes(match.leagueCode)) continue;
    if (ahead <= ODDS_NEAR_HOURS * HOUR) { near.add(match.leagueCode); nearCount += 1; }
    else { far.add(match.leagueCode); farCount += 1; }
  }
  const leagues = input.allLeagues.filter((code) => near.has(code) || far.has(code));
  const base = { near: nearCount, far: farCount };
  if (nearCount > 0) return { fetch: true, leagues, reason: "hay partidos en las próximas 24 h", ...base };
  if (farCount > 0) {
    const due = !input.scheduled || t - input.lastFetchAt >= ODDS_FAR_ONLY_INTERVAL_MS;
    return due
      ? { fetch: true, leagues, reason: "solo hay partidos entre 24 y 48 h", ...base }
      : { fetch: false, leagues: [], reason: "solo hay partidos entre 24 y 48 h y la última consulta fue hace menos de 24 h", ...base };
  }
  if (input.calendarKnown) {
    return { fetch: false, leagues: [], reason: "sin partidos de las ligas elegidas en las próximas 48 h", ...base };
  }
  const due = !input.scheduled || t - input.lastDiscoveryAt >= ODDS_DISCOVERY_INTERVAL_MS;
  return due
    ? { fetch: true, leagues: input.allLeagues, reason: "calendario desconocido: consulta de descubrimiento", ...base }
    : { fetch: false, leagues: [], reason: "calendario desconocido y el descubrimiento ya se hizo hace menos de 24 h", ...base };
}

/** Huella estable del contenido de cuotas de un evento (independiente del orden). */
export function quotesDigest(
  quotes: Array<{
    bookmaker: string; marketName: string; selection: string; playerName: string | null;
    line: number | null; decimalOdds: number; sourceUpdatedAt: Date | null;
  }>,
): string {
  const keys = quotes
    .map((q) => [q.bookmaker, q.marketName, q.selection, q.playerName ?? "", q.line ?? "", q.decimalOdds, q.sourceUpdatedAt?.toISOString() ?? ""].join("|"))
    .sort();
  return createHash("sha256").update(keys.join("\n")).digest("hex");
}
