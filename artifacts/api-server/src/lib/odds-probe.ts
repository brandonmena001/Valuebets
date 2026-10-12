/**
 * Sonda de UNA llamada a OddsPapi para una casa (Pinnacle por defecto). No guarda cuotas.
 * Suma 1 al contador de cuota. Sin el argumento "--ejecutar" solo explica qué haría (0 llamadas).
 * Uso: pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/src/lib/odds-probe.ts pinnacle --ejecutar
 */
import { db, providerCacheTable, providerTournamentsTable, sourceStatusTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { fetchTournamentOdds, type OddsPapiBookmaker, type OddsPapiMarket, type TournamentRef } from "../services/oddspapi";

const LOCAL_CAP = 200;
const SAFETY = 12;
const slug = (process.argv[2] ?? "pinnacle").toLowerCase();
const execute = process.argv.includes("--ejecutar");
const say = (...parts: unknown[]) => console.log(...parts);

async function main() {
  const [cache] = await db.select().from(providerCacheTable).where(eq(providerCacheTable.key, "oddspapi-reference")).limit(1);
  if (!cache) { say("Falta el catálogo guardado: espera una sincronización real y repite."); return; }
  const saved = JSON.parse(cache.payload) as { bookmakers: OddsPapiBookmaker[]; participants: Record<string, string>; markets: OddsPapiMarket[] };
  const bookmaker = saved.bookmakers.find((b) => b.slug.toLowerCase() === slug);
  if (!bookmaker) {
    say(`La casa "${slug}" no está en el catálogo. Parecidas:`, saved.bookmakers.filter((b) => b.slug.toLowerCase().includes(slug.slice(0, 4))).map((b) => b.slug).join(", ") || "ninguna");
    return;
  }
  const rows = await db.select().from(providerTournamentsTable).where(eq(providerTournamentsTable.provider, "oddspapi"));
  const tournaments: TournamentRef[] = rows.map((r) => ({ leagueCode: r.leagueCode as TournamentRef["leagueCode"], tournamentId: r.upstreamTournamentId, tournamentName: r.tournamentName }));
  const [status] = await db.select().from(sourceStatusTable).where(eq(sourceStatusTable.provider, "oddspapi"));
  const used = status?.requestsUsed ?? 0;
  say(`Casa: ${bookmaker.slug} | torneos: ${tournaments.map((t) => t.leagueCode).join(", ")} | cuota usada: ${used}/${LOCAL_CAP}`);
  if (!tournaments.length) { say("No hay torneos guardados."); return; }
  if (!execute) { say("Simulación: haría 1 llamada a OddsPapi. Agrega --ejecutar para hacerla."); return; }
  if (used >= LOCAL_CAP - SAFETY) { say(`No se ejecuta: quedan menos de ${SAFETY} llamadas.`); return; }
  await db.update(sourceStatusTable).set({ requestsUsed: sql`${sourceStatusTable.requestsUsed} + 1` }).where(eq(sourceStatusTable.provider, "oddspapi"));
  const { events } = await fetchTournamentOdds(tournaments, bookmaker, saved.participants, saved.markets);
  const quotes = events.flatMap((e) => e.quotes.map((q) => ({ ...q, league: e.leagueCode })));
  say(`\nRESULTADO (1 llamada, nada guardado): ${events.length} eventos, ${quotes.length} cuotas`);
  const count = (key: (q: (typeof quotes)[number]) => string) => {
    const map = new Map<string, number>();
    for (const q of quotes) map.set(key(q), (map.get(key(q)) ?? 0) + 1);
    return [...map.entries()].sort().map(([k, v]) => `${k}: ${v}`).join(" | ") || "ninguna";
  };
  say("Eventos por liga:", [...new Set(events.map((e) => e.leagueCode))].map((l) => `${l}: ${events.filter((e) => e.leagueCode === l).length}`).join(" | ") || "ninguno");
  say("Cuotas por categoría:", count((q) => q.marketCategory));
  const withHouse = quotes.filter((q) => q.bookmakerChangedAt).length;
  say(`Con hora que reporta la casa (bookmakerChangedAt): ${withHouse} de ${quotes.length}`);
  const ages = quotes.filter((q) => q.sourceUpdatedAt).map((q) => (Date.now() - q.sourceUpdatedAt!.getTime()) / 3_600_000).sort((a, b) => a - b);
  if (ages.length) say(`Antigüedad de changedAt (horas): mínima ${ages[0]!.toFixed(1)}, mediana ${ages[Math.floor(ages.length / 2)]!.toFixed(1)}, máxima ${ages[ages.length - 1]!.toFixed(1)}`);
}
main().then(() => process.exit(0)).catch((error) => { console.error("FALLO", error instanceof Error ? error.message : error); process.exit(1); });
