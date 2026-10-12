/**
 * Reporte de alertas de precio (`price_anomalies`):
 *  1. % de alertas que sobreviven a la siguiente sincronización (por tipo);
 *  2. distribución de desviaciones (high-price);
 *  3. tras liquidar los partidos: CLV y ROI por tipo y veredicto.
 *
 * Uso (desde la raíz del repo):
 *   pnpm --filter @workspace/scripts exec tsx src/anomaly-report.ts --sim [--n=3000] [--seed=1] [--out=informe.md]
 *   pnpm --filter @workspace/scripts exec tsx src/anomaly-report.ts --input=alertas.json [--out=informe.md]
 *
 * --sim usa datos SIMULADOS: solo valida que el reporte funciona. No es evidencia de nada.
 *
 * --input espera un arreglo JSON exportado de la base real. Este paquete no depende de la BD,
 * así que se exporta con psql (cierre = última cuota guardada de la misma casa y selección):
 *
 *   psql "$DATABASE_URL" -At -c "
 *   select coalesce(json_agg(json_build_object(
 *     'kind', a.kind, 'verdict', a.verdict, 'score', a.score, 'deviationPct', a.deviation_pct,
 *     'persistedSyncs', a.persisted_syncs, 'expired', a.expired_at is not null,
 *     'decimalOdds', a.decimal_odds, 'marketCategory', a.market_category, 'selectionKey', a.selection_key,
 *     'line', a.line, 'playerName', a.player_name, 'voidRisk', a.void_risk,
 *     'homeScore', m.home_score, 'awayScore', m.away_score,
 *     'closingOdds', (select q.decimal_odds from odds_quotes q
 *        where q.match_id = a.match_id and q.bookmaker = a.bookmaker and q.market_name = a.market_name
 *          and q.selection = a.selection
 *          and coalesce(q.line, -999) = coalesce(a.line, -999)
 *          and coalesce(q.player_name, '') = coalesce(a.player_name, '')
 *        order by q.captured_at desc limit 1)
 *   )), '[]'::json)
 *   from price_anomalies a join matches m on m.id = a.match_id" > alertas.json
 *
 * Sin liquidar (homeScore nulo) las filas cuentan para supervivencia y desviaciones, no para ROI.
 */
import fs from "node:fs";
import { lineReturn, type LineResult } from "../../artifacts/api-server/src/model/lines";
import { settleOutcome } from "../../artifacts/api-server/src/model/settle";
import { sum } from "../../artifacts/api-server/src/model/math";

export type ReportRow = {
  kind: string;
  verdict: string;
  score: number;
  deviationPct: number | null;
  persistedSyncs: number;
  expired: boolean;
  decimalOdds: number;
  closingOdds: number | null;
  /** Resultado de la apuesta si ya se pudo liquidar. */
  outcome: LineResult | null;
  voidRisk?: string;
};

type RawRow = Omit<ReportRow, "outcome"> & {
  marketCategory?: string; selectionKey?: string; line?: number | null; playerName?: string | null;
  homeScore?: number | null; awayScore?: number | null; outcome?: LineResult | null;
};

export function rowsFromExport(raw: RawRow[]): ReportRow[] {
  return raw.map((r) => {
    let outcome: LineResult | null = r.outcome ?? null;
    if (outcome === null && r.kind !== "arbitrage" && r.homeScore != null && r.awayScore != null && r.marketCategory && r.selectionKey) {
      outcome = settleOutcome({
        marketCategory: r.marketCategory, selectionKey: r.selectionKey, line: r.line ?? null, playerName: r.playerName ?? null,
        homeScore: r.homeScore, awayScore: r.awayScore, stats: null, playerShots: null,
      });
    }
    return {
      kind: r.kind, verdict: r.verdict, score: r.score, deviationPct: r.deviationPct, persistedSyncs: r.persistedSyncs,
      expired: r.expired, decimalOdds: r.decimalOdds, closingOdds: r.closingOdds ?? null, outcome, voidRisk: r.voidRisk,
    };
  });
}

// ---------- Estadística ----------
const f1 = (v: number | null) => (v === null || !Number.isFinite(v) ? "n/d" : v.toFixed(1));
const f2 = (v: number | null) => (v === null || !Number.isFinite(v) ? "n/d" : v.toFixed(2));
function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}
function meanSe(xs: number[]): { mean: number | null; se: number | null; n: number } {
  const n = xs.length;
  if (!n) return { mean: null, se: null, n: 0 };
  const mean = sum(xs) / n;
  const variance = n > 1 ? sum(xs.map((x) => (x - mean) ** 2)) / (n - 1) : 0;
  return { mean, se: Math.sqrt(variance / n), n };
}
const group = <T,>(rows: T[], key: (r: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const l = m.get(k);
    if (l) l.push(r);
    else m.set(k, [r]);
  }
  return new Map([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));
};

export function buildAnomalyReport(rows: ReportRow[], opts: { simulated?: boolean } = {}): string {
  const out: string[] = [];
  const w = (s = "") => out.push(s);
  w("# Reporte de alertas de precio");
  w();
  if (opts.simulated) w("**DATOS SIMULADOS: valida el reporte, no es evidencia.** En la simulación se supone que la probabilidad real es el consenso, que es justo lo que habría que comprobar con datos reales.");
  w(`- Alertas analizadas: ${rows.length}.`);
  w("- Qué NO mide: no hay forma de saber si la casa habría aceptado o anulado la apuesta ni si la cuenta se habría limitado; el ROI supone que se acepta.");

  // 1. Supervivencia
  w();
  w("## 1. Alertas que sobreviven a la siguiente sincronización");
  w();
  w("Solo cuentan las que ya tuvieron una sincronización posterior (persistieron al menos 1 vez o ya expiraron).");
  w();
  w("| Tipo | Con sync posterior | Sobreviven | % |");
  w("|---|---|---|---|");
  const eligible = rows.filter((r) => r.persistedSyncs >= 1 || r.expired);
  for (const [kind, list] of group(eligible, (r) => r.kind)) {
    const s = list.filter((r) => r.persistedSyncs >= 1).length;
    w(`| ${kind} | ${list.length} | ${s} | ${f1((s / list.length) * 100)} |`);
  }
  const sAll = eligible.filter((r) => r.persistedSyncs >= 1).length;
  w(`| **todas** | ${eligible.length} | ${sAll} | ${eligible.length ? f1((sAll / eligible.length) * 100) : "n/d"} |`);
  w();
  w("Pendientes (activas y aún sin sync posterior): " + rows.filter((r) => r.persistedSyncs < 1 && !r.expired).length + ".");

  // 2. Desviaciones
  w();
  w("## 2. Distribución de desviaciones (high-price)");
  w();
  const dev = rows.filter((r) => r.kind === "high-price" && r.deviationPct !== null).map((r) => r.deviationPct!).sort((a, b) => a - b);
  if (!dev.length) w("Sin alertas high-price.");
  else {
    w(`n=${dev.length}; mediana ${f1(quantile(dev, 0.5))} %, p90 ${f1(quantile(dev, 0.9))} %, máximo ${f1(dev.at(-1)!)} %.`);
    w();
    w("| Tramo | Alertas | % |");
    w("|---|---|---|");
    const bins: Array<[string, number, number]> = [["6–10 %", 6, 10], ["10–15 %", 10, 15], ["15–25 % (medio)", 15, 25], [">25 % (alto)", 25, Infinity]];
    for (const [label, lo, hi] of bins) {
      const c = dev.filter((d) => d >= lo && d < hi).length;
      w(`| ${label} | ${c} | ${f1((c / dev.length) * 100)} |`);
    }
  }
  w();
  w("Alertas por tipo y veredicto:");
  w();
  w("| Tipo | tomar | vigilar | descartar |");
  w("|---|---|---|---|");
  for (const [kind, list] of group(rows, (r) => r.kind)) {
    const c = (v: string) => list.filter((r) => r.verdict === v).length;
    w(`| ${kind} | ${c("tomar")} | ${c("vigilar")} | ${c("descartar")} |`);
  }

  // 3. CLV y ROI
  w();
  w("## 3. CLV y ROI por tipo y veredicto");
  w();
  w("CLV = cuota de la alerta / última cuota guardada de la misma casa − 1 (con cuotas cada 7–13 h es solo una aproximación al cierre). ROI = apuesta plana de 1 unidad, ganancia neta con push y medias ganancias; ignora anulaciones. `arbitrage` no entra (sus patas están en varias casas).");
  w();
  w("| Tipo | Veredicto | n CLV | CLV medio % | n ROI | ROI % ± error est. |");
  w("|---|---|---|---|---|---|");
  for (const [key, list] of group(rows.filter((r) => r.kind !== "arbitrage"), (r) => `${r.kind}|${r.verdict}`)) {
    const [kind, verdict] = key.split("|");
    const clv = meanSe(list.filter((r) => r.closingOdds && r.closingOdds > 1).map((r) => (r.decimalOdds / r.closingOdds! - 1) * 100));
    const roi = meanSe(list.filter((r) => r.outcome !== null).map((r) => lineReturn(r.outcome!, r.decimalOdds) * 100));
    w(`| ${kind} | ${verdict} | ${clv.n} | ${f2(clv.mean)} | ${roi.n} | ${roi.n ? `${f2(roi.mean)} ± ${f2(roi.se)}` : "n/d"} |`);
  }
  w();
  w("Con pocas alertas liquidadas el error estándar es enorme: un ROI cuyo intervalo (≈ ±2 errores) incluye 0 no demuestra nada. No se promete rentabilidad.");
  return out.join("\n");
}

// ---------- Simulación ----------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function simulateRows(n: number, seed: number): ReportRow[] {
  const rand = mulberry32(seed);
  const rows: ReportRow[] = [];
  for (let i = 0; i < n; i += 1) {
    const r = rand();
    const kind = r < 0.6 ? "high-price" : r < 0.7 ? "arbitrage" : r < 0.8 ? "inconsistent-line" : r < 0.88 ? "swapped-selection" : r < 0.94 ? "stale-line" : "invalid-odds";
    const pFair = 0.15 + rand() * 0.55;
    const deviation = kind === "high-price" ? 0.06 + Math.abs(rand() - rand()) * 0.4 : 0;
    const odds = (1 / pFair) * (1 + deviation);
    const persisted = rand() < 0.45 ? 1 + Math.floor(rand() * 3) : 0;
    const expired = persisted === 0 && rand() < 0.7;
    const score = Math.round(40 + rand() * 55 - (kind === "stale-line" ? 25 : 0));
    const verdict = kind === "stale-line" || kind === "invalid-odds" || score < 40 ? "descartar" : score >= 70 && kind === "high-price" && deviation < 0.25 ? "tomar" : "vigilar";
    // Hipótesis simulada: la probabilidad real es la del consenso; el cierre corrige la mitad del error.
    const closing = odds / (1 + deviation / 2);
    const outcome: LineResult | null = rand() < 0.8 ? (rand() < pFair ? "win" : "loss") : null;
    rows.push({ kind, verdict, score, deviationPct: kind === "high-price" ? deviation * 100 : null, persistedSyncs: persisted, expired, decimalOdds: odds, closingOdds: closing, outcome });
  }
  return rows;
}

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const get = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  let report: string;
  if (args.includes("--sim")) {
    report = buildAnomalyReport(simulateRows(Number(get("n") ?? 3000), Number(get("seed") ?? 1)), { simulated: true });
  } else if (get("input")) {
    report = buildAnomalyReport(rowsFromExport(JSON.parse(fs.readFileSync(get("input")!, "utf8")) as RawRow[]));
  } else {
    console.error("Uso: anomaly-report --sim [--n=3000] [--seed=1] | --input=alertas.json  [--out=informe.md]");
    process.exit(1);
  }
  console.log(report);
  const outPath = get("out");
  if (outPath) fs.writeFileSync(outPath, report + "\n");
}

import path from "node:path";
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
