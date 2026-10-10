import { resolveName } from "../model/names";

export type UpcomingTeam = { leagueCode: string; team: string };

/**
 * Equipos de partidos próximos que `resolveName` no logra emparejar con ningún equipo del
 * historial de su liga. Sin historial emparejado el modelo no puede predecir ese partido.
 * Devuelve cada par liga/equipo una sola vez, ordenado.
 */
export function findUnmatchedTeams(
  upcoming: UpcomingTeam[],
  historyByLeague: Map<string, string[]>,
): Array<{ leagueCode: string; team: string; reason: "sin historial" | "sin coincidencia" }> {
  const out = new Map<string, { leagueCode: string; team: string; reason: "sin historial" | "sin coincidencia" }>();
  for (const { leagueCode, team } of upcoming) {
    const key = `${leagueCode}|${team}`;
    if (out.has(key)) continue;
    const known = historyByLeague.get(leagueCode) ?? [];
    if (!known.length) { out.set(key, { leagueCode, team, reason: "sin historial" }); continue; }
    if (resolveName(team, known) == null) out.set(key, { leagueCode, team, reason: "sin coincidencia" });
  }
  return [...out.values()].sort((a, b) => a.leagueCode.localeCompare(b.leagueCode) || a.team.localeCompare(b.team));
}
