/**
 * Reporte de solo lectura (no escribe nada, no llama a APIs, no gasta cuota).
 * Uso: cd artifacts/api-server && pnpm exec tsx src/lib/odds-report.ts
 */
import { db, historicalResultsTable, matchesTable, providerCacheTable } from "@workspace/db";
import { fetchUpcomingFixtures } from "../services/football-data";
import { and, eq, gte, lte, ne, sql } from "drizzle-orm";
import { fixedIntervalCalls, planCaptures } from "./odds-budget";

type Row = Record<string, unknown>;
const rows = async (query: ReturnType<typeof sql>): Promise<Row[]> => (await db.execute(query)).rows as Row[];
const line = (...parts: unknown[]) => console.log(parts.join(" "));
const DAY = 86_400_000;

async function section(title: string, run: () => Promise<void>) {
  line(`\n== ${title}`);
  try { await run(); } catch (error) { line("  (no disponible:", error instanceof Error ? error.message.split("\n")[0] : "error", ")"); }
}

async function main() {
  await section("1. CASAS", async () => {
    for (const r of await rows(sql`select bookmaker, count(*) quotes, count(distinct match_id) matches, max(captured_at) last from odds_quotes group by 1 order by 2 desc`))
      line(` ${r.bookmaker}: ${r.quotes} cuotas, ${r.matches} partidos, última captura ${new Date(r.last as string).toISOString()}`);
  });
  await section("2. COBERTURA POR LIGA (partidos con cuotas de cada casa)", async () => {
    for (const r of await rows(sql`select m.league_code, o.bookmaker, count(distinct o.match_id) matches from odds_quotes o join matches m on m.id = o.match_id group by 1,2 order by 1,2`))
      line(` ${r.league_code} | ${r.bookmaker}: ${r.matches} partidos`);
  });
  await section("3. COBERTURA POR MERCADO (categoría | casa: tipos de mercado, cuotas)", async () => {
    for (const r of await rows(sql`select market_category, bookmaker, count(distinct market_name) tipos, count(*) quotes from odds_quotes group by 1,2 order by 1,2`))
      line(` ${r.market_category} | ${r.bookmaker}: ${r.tipos} tipos, ${r.quotes} cuotas`);
  });
  await section("4. RELOJ POR CASA (¿source_updated_at es de cada cuota o del evento?)", async () => {
    for (const r of await rows(sql`select bookmaker, count(*) partidos, round(avg(n),1) horas_distintas_por_partido, sum((n = 1)::int) partidos_con_una_sola_hora from (select bookmaker, match_id, count(distinct source_updated_at) n from odds_quotes group by 1,2) t group by 1`))
      line(` ${r.bookmaker}: ${r.partidos} partidos, media ${r.horas_distintas_por_partido} horas distintas por partido, ${r.partidos_con_una_sola_hora} con una sola hora`);
    for (const r of await rows(sql`select bookmaker, count(*) filas, count(bookmaker_changed_at) con_hora_de_casa from odds_quotes group by 1`))
      line(` ${r.bookmaker}: ${r.con_hora_de_casa} de ${r.filas} filas con hora que reporta la casa (solo cuenta desde la sincronización posterior al db push)`);
  });
  await section("5. CASAS DISPONIBLES EN EL CATÁLOGO GUARDADO (¿hay referencia aguda?)", async () => {
    const [row] = await db.select().from(providerCacheTable).where(eq(providerCacheTable.key, "oddspapi-reference")).limit(1);
    if (!row) { line(" Aún no hay catálogo guardado (aparece tras la primera sincronización real posterior al db push)."); return; }
    const books = ((JSON.parse(row.payload) as { bookmakers?: Array<{ slug: string; name: string }> }).bookmakers ?? []);
    const sharp = books.filter((b) => /pinnacle|sbobet|singbet|betfair|matchbook/i.test(`${b.slug} ${b.name}`));
    line(` ${books.length} casas en el catálogo. Agudas/exchange encontradas: ${sharp.length ? sharp.map((b) => b.slug).join(", ") : "ninguna"}`);
    line(" (que figure en el catálogo NO prueba que devuelva cuotas de estas ligas con tu clave)");
  });
  await section("6. GASTO DE CUOTA CON TU CALENDARIO REAL (2 y 3 casas)", async () => {
    const now = new Date();
    const past = (await db.select({ kickoff: historicalResultsTable.kickoff }).from(historicalResultsTable).where(and(gte(historicalResultsTable.kickoff, new Date(now.getTime() - 30 * DAY)), lte(historicalResultsTable.kickoff, now)))).map((r) => r.kickoff);
    const known = (await db.select({ kickoff: matchesTable.kickoff }).from(matchesTable).where(and(gte(matchesTable.kickoff, now), lte(matchesTable.kickoff, new Date(now.getTime() + 14 * DAY)), ne(matchesTable.status, "cancelled")))).map((r) => r.kickoff);
    const upcoming = await fetchUpcomingFixtures();
    const horizon = new Date(now.getTime() + 14 * DAY);
    const fromCsv = upcoming.ok ? upcoming.fixtures.map((f) => f.kickoff).filter((k) => k >= now && k <= horizon) : [];
    const merged = [...new Map([...known, ...fromCsv].map((k) => [k.getTime(), k])).values()];
    const lastCsv = fromCsv.length ? new Date(Math.max(...fromCsv.map((k) => k.getTime()))).toISOString() : "sin datos";
    line(` fixtures.csv: ${upcoming.ok ? `${fromCsv.length} partidos de las 3 ligas (último ${lastCsv})` : `no disponible (${upcoming.error})`}`);
    for (const [label, kickoffs, days] of [
      ["próximos 14 días (fixtures.csv + base; el CSV puede no llegar a 14 días)", merged, 14],
      ["últimos 30 días (historial importado: calendario completo de las 3 ligas)", past, 30],
    ] as const) {
      const two = planCaptures(kickoffs, { callsPerCapture: 2 });
      const three = planCaptures(kickoffs, { callsPerCapture: 3 });
      line(` ${label}: ${kickoffs.length} partidos -> ${two.captures.length} capturas`);
      line(`   2 casas: ${two.calls} llamadas (${Math.round((two.calls / 200) * 100)}% del tope) | 3 casas: ${three.calls} llamadas (${Math.round((three.calls / 200) * 100)}%), sin cubrir ${three.uncovered}`);
      line(`   referencia: intervalo fijo de 8 h en ${days} días = ${fixedIntervalCalls(days, 8)} llamadas`);
    }
  });
  process.exit(0);
}
main().catch((error) => { console.error("FALLO", error instanceof Error ? error.message : error); process.exit(1); });
