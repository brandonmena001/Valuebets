/**
 * Compuerta del proyecto: ¿el modelo aporta algo frente al mercado?
 *
 * Validación walk-forward (cada partido se predice solo con partidos anteriores) sobre CSV de
 * football-data.co.uk. Compara el modelo, la mezcla de producción y el mercado contra la cuota de
 * CIERRE de Pinnacle sin margen (el mejor referente gratuito de «probabilidad real»), y simula
 * apostar a la cuota previa al cierre de Bet365 los casos con valor para medir el CLV.
 */
import { ESS_HALF_WEIGHT, maxModelWeight, modelConfig } from "../../artifacts/api-server/src/model/config";
import { devigPower } from "../../artifacts/api-server/src/model/math";
import { normalizeName } from "../../artifacts/api-server/src/model/names";
import { fitLeagueModel, type HistoryMatch } from "../../artifacts/api-server/src/model/predict";
import { expectedRates, resultProbs, scoreMatrix } from "../../artifacts/api-server/src/model/strength";
import { parseCsv } from "../../artifacts/api-server/src/services/football-data-parse";

export type P3 = [number, number, number]; // local, empate, visitante

export type Row = {
  league: string;
  season: string;
  kickoff: Date;
  home: string;
  away: string;
  hg: number;
  ag: number;
  pinClose?: P3;
  b365Pre?: P3;
  avgPre?: P3;
  maxPre?: P3;
  avgClose?: P3;
};

const DAY = 86_400_000;

function parseDate(dateText: string, timeText: string): Date | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(dateText.trim());
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  const t = /^(\d{1,2}):(\d{2})/.exec(timeText.trim());
  const date = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1]), t ? Number(t[1]) : 15, t ? Number(t[2]) : 0));
  return Number.isNaN(date.getTime()) ? null : date;
}

// Conjuntos de columnas por campo, en orden de preferencia (nombres confirmados en notes.txt).
const COLUMN_SETS: Record<"pinClose" | "b365Pre" | "avgPre" | "maxPre" | "avgClose", string[][]> = {
  pinClose: [["PSCH", "PSCD", "PSCA"]],
  b365Pre: [["B365H", "B365D", "B365A"]],
  avgPre: [["AvgH", "AvgD", "AvgA"], ["BbAvH", "BbAvD", "BbAvA"]],
  maxPre: [["MaxH", "MaxD", "MaxA"], ["BbMxH", "BbMxD", "BbMxA"]],
  avgClose: [["AvgCH", "AvgCD", "AvgCA"]],
};

/** Lee un CSV de football-data.co.uk por nombre de columna; ignora filas sin resultado. */
export function readRows(text: string, league: string, season: string): Row[] {
  const rows = parseCsv(text);
  const header = rows[0]?.map((h) => h.trim());
  if (!header) return [];
  const col = (name: string) => header.indexOf(name);
  const [iDate, iTime, iHome, iAway, iHg, iAg] = ["Date", "Time", "HomeTeam", "AwayTeam", "FTHG", "FTAG"].map(col) as number[];
  if ([iDate, iHome, iAway, iHg, iAg].some((i) => i! < 0)) return [];
  const out: Row[] = [];
  for (const r of rows.slice(1)) {
    const kickoff = parseDate(r[iDate!] ?? "", iTime! >= 0 ? r[iTime!] ?? "" : "");
    const home = r[iHome!]?.trim();
    const away = r[iAway!]?.trim();
    const hgText = r[iHg!]?.trim() ?? "";
    const agText = r[iAg!]?.trim() ?? "";
    if (!kickoff || !home || !away || hgText === "" || agText === "") continue;
    const hg = Number(hgText);
    const ag = Number(agText);
    if (!Number.isInteger(hg) || !Number.isInteger(ag)) continue;
    const row: Row = { league, season, kickoff, home, away, hg, ag };
    for (const [field, sets] of Object.entries(COLUMN_SETS) as Array<[keyof typeof COLUMN_SETS, string[][]]>) {
      for (const set of sets) {
        const idx = set.map(col);
        if (idx.some((i) => i < 0)) continue;
        const values = idx.map((i) => Number(r[i] ?? ""));
        if (values.every((v) => Number.isFinite(v) && v > 1)) {
          row[field] = values as P3;
          break;
        }
      }
    }
    out.push(row);
  }
  return out;
}

// ---------- Estadística ----------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type CI = { mean: number; lo: number; hi: number; n: number };

/** Media con IC95 % por bootstrap (remuestreo con reemplazo). */
export function bootstrapMean(values: number[], resamples = 2000, seed = 11): CI {
  const n = values.length;
  if (n === 0) return { mean: NaN, lo: NaN, hi: NaN, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, lo: NaN, hi: NaN, n };
  const rnd = mulberry32(seed);
  const means: number[] = [];
  for (let b = 0; b < resamples; b += 1) {
    let total = 0;
    for (let i = 0; i < n; i += 1) total += values[Math.floor(rnd() * n)]!;
    means.push(total / n);
  }
  means.sort((x, y) => x - y);
  return { mean, lo: means[Math.floor(resamples * 0.025)]!, hi: means[Math.floor(resamples * 0.975)]!, n };
}

function devig3(odds: P3 | undefined): P3 | null {
  if (!odds) return null;
  const p = devigPower(odds);
  return p ? ([p[0]!, p[1]!, p[2]!] as P3) : null;
}

const logLoss = (p: P3, y: number) => -Math.log(Math.max(1e-9, p[y]!));
const brier = (p: P3, y: number) => p.reduce((s, v, i) => s + (v - (i === y ? 1 : 0)) ** 2, 0);

// ---------- Walk-forward ----------
export type Prediction = {
  league: string;
  kickoff: Date;
  y: number;
  raw: P3;
  ess: number;
  /** Mercado previo al cierre sin margen (promedio de casas): lo que tendríamos en producción. */
  market: P3;
  blend: P3;
  /** Referente: Pinnacle de cierre sin margen (o promedio de cierre si Pinnacle falta). */
  bench: P3;
  benchSource: "pinnacle" | "avg-cierre";
  b365?: P3;
  max?: P3;
};

export type WalkForwardOptions = { stepDays?: number; burnInDays?: number };

export function walkForward(rows: Row[], options: WalkForwardOptions = {}): Prediction[] {
  const stepDays = options.stepDays ?? 7;
  const burnInDays = options.burnInDays ?? 300;
  const byLeague = new Map<string, Row[]>();
  for (const row of rows) byLeague.set(row.league, [...(byLeague.get(row.league) ?? []), row]);
  const out: Prediction[] = [];
  for (const [league, leagueRows] of byLeague) {
    const sorted = [...leagueRows].sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());
    if (!sorted.length) continue;
    const start = sorted[0]!.kickoff.getTime();
    const history: HistoryMatch[] = sorted.map((r, i) => ({
      id: i + 1, leagueCode: league, homeTeam: r.home, awayTeam: r.away, kickoff: r.kickoff,
      homeScore: r.hg, awayScore: r.ag, homeCorners: null, awayCorners: null, homeYellowCards: null,
      awayYellowCards: null, homeRedCards: null, awayRedCards: null, homeShotsOnTarget: null, awayShotsOnTarget: null,
    }));
    let cursor = start + burnInDays * DAY;
    const end = sorted.at(-1)!.kickoff.getTime();
    while (cursor <= end) {
      const blockStart = new Date(cursor);
      const blockEnd = cursor + stepDays * DAY;
      // fitLeagueModel solo usa partidos con kickoff < blockStart (regla anti-fuga).
      const model = fitLeagueModel(history, league, "goals", blockStart);
      if (model) {
        for (const r of sorted) {
          const t = r.kickoff.getTime();
          if (t < cursor || t >= blockEnd) continue;
          const rates = expectedRates(model.model, normalizeName(r.home), normalizeName(r.away));
          if (!rates || rates.ess < modelConfig.minTeamEss) continue;
          const market = devig3(r.avgPre);
          const bench = devig3(r.pinClose) ?? devig3(r.avgClose);
          if (!market || !bench) continue;
          const probs = resultProbs(scoreMatrix(rates.lh, rates.la, model.model.rho));
          const raw: P3 = [probs.home, probs.draw, probs.away];
          const w = maxModelWeight["match-result"] * (rates.ess / (rates.ess + ESS_HALF_WEIGHT));
          const blend = raw.map((v, i) => w * v + (1 - w) * market[i]!) as P3;
          out.push({
            league, kickoff: r.kickoff, y: r.hg > r.ag ? 0 : r.hg === r.ag ? 1 : 2, raw, ess: rates.ess, market, blend,
            bench, benchSource: r.pinClose && devig3(r.pinClose) ? "pinnacle" : "avg-cierre", b365: r.b365Pre, max: r.maxPre,
          });
        }
      }
      cursor = blockEnd;
    }
  }
  return out;
}

// ---------- Evaluación ----------
export type BetStats = { bets: number; clv: CI; roi: CI; hitRate: number };
export type ScenarioResult = { model: BetStats; baseline: BetStats };

export type GateResult = {
  matches: number;
  leagues: string[];
  pinnacleShare: number;
  quality: {
    logLoss: { model: number; blend: number; market: number; bench: number };
    brier: { model: number; blend: number; market: number; bench: number };
    blendMinusBench: CI;
    blendMinusMarket: CI;
  };
  scenarios: { b365: ScenarioResult; max: ScenarioResult };
  calibration: Array<{ bin: string; n: number; predicted: number; observed: number }>;
  verdict: "ventaja demostrada" | "utilidad como filtro" | "sin ventaja demostrada" | "datos insuficientes";
  verdictReasons: string[];
};

const MIN_BETS_FOR_VERDICT = 200;
/** Por debajo de esto no se emite veredicto: con pocos partidos «sin ventaja» sería una conclusión falsa. */
const MIN_MATCHES_FOR_VERDICT = 1000;

function simulateBets(preds: Prediction[], source: "b365" | "max", useModel: boolean): BetStats {
  const cfg = modelConfig;
  const clvs: number[] = [];
  const rois: number[] = [];
  for (const p of preds) {
    const odds = p[source];
    if (!odds) continue;
    for (let k = 0; k < 3; k += 1) {
      const price = odds[k]!;
      if (price < cfg.minOdds || price > cfg.maxOdds) continue;
      const marketEv = (p.market[k]! * price - 1) * 100;
      if (marketEv > cfg.maxMarketEvPct) continue; // cuota atípica: se descarta, como en producción
      if (useModel) {
        const evBlend = (p.blend[k]! * price - 1) * 100;
        if (evBlend < cfg.minEvPct || evBlend > cfg.maxEvPct) continue;
        if (p.raw[k]! * price < 1) continue; // doble confirmación
        if (p.raw[k]! - p.market[k]! > cfg.maxModelMarketGap) continue;
      } else if (marketEv < cfg.minEvPct) {
        continue; // sin modelo: solo precio frente al consenso del mercado
      }
      clvs.push(price * p.bench[k]! - 1); // cuota tomada frente a la cuota justa de cierre
      rois.push(p.y === k ? price - 1 : -1);
    }
  }
  return {
    bets: clvs.length,
    clv: bootstrapMean(clvs),
    roi: bootstrapMean(rois, 2000, 23),
    hitRate: rois.length ? rois.filter((r) => r > 0).length / rois.length : NaN,
  };
}

export function evaluate(preds: Prediction[]): GateResult {
  const mean = (f: (p: Prediction) => number) => (preds.length ? preds.reduce((s, p) => s + f(p), 0) / preds.length : NaN);
  const diffBench = preds.map((p) => logLoss(p.blend, p.y) - logLoss(p.bench, p.y));
  const diffMarket = preds.map((p) => logLoss(p.blend, p.y) - logLoss(p.market, p.y));
  const quality = {
    logLoss: {
      model: mean((p) => logLoss(p.raw, p.y)), blend: mean((p) => logLoss(p.blend, p.y)),
      market: mean((p) => logLoss(p.market, p.y)), bench: mean((p) => logLoss(p.bench, p.y)),
    },
    brier: {
      model: mean((p) => brier(p.raw, p.y)), blend: mean((p) => brier(p.blend, p.y)),
      market: mean((p) => brier(p.market, p.y)), bench: mean((p) => brier(p.bench, p.y)),
    },
    blendMinusBench: bootstrapMean(diffBench, 2000, 5),
    blendMinusMarket: bootstrapMean(diffMarket, 2000, 6),
  };
  const scenarios = {
    b365: { model: simulateBets(preds, "b365", true), baseline: simulateBets(preds, "b365", false) },
    max: { model: simulateBets(preds, "max", true), baseline: simulateBets(preds, "max", false) },
  };
  // Calibración de la mezcla: probabilidad local/empate/visitante en 10 tramos.
  const bins = Array.from({ length: 10 }, () => ({ n: 0, pred: 0, obs: 0 }));
  for (const p of preds) {
    for (let k = 0; k < 3; k += 1) {
      const b = Math.min(9, Math.floor(p.blend[k]! * 10));
      bins[b]!.n += 1;
      bins[b]!.pred += p.blend[k]!;
      bins[b]!.obs += p.y === k ? 1 : 0;
    }
  }
  const calibration = bins
    .map((b, i) => ({ bin: `${i * 10}–${i * 10 + 10} %`, n: b.n, predicted: b.n ? b.pred / b.n : NaN, observed: b.n ? b.obs / b.n : NaN }))
    .filter((b) => b.n > 0);

  // Veredicto (criterio de docs/hoja-de-ruta.md).
  const reasons: string[] = [];
  let verdict: GateResult["verdict"] = "sin ventaja demostrada";
  const q = quality.blendMinusBench;
  if (preds.length < MIN_MATCHES_FOR_VERDICT) {
    return {
      matches: preds.length,
      leagues: [...new Set(preds.map((p) => p.league))].sort(),
      pinnacleShare: preds.length ? preds.filter((p) => p.benchSource === "pinnacle").length / preds.length : 0,
      quality, scenarios, calibration,
      verdict: "datos insuficientes",
      verdictReasons: [
        `Solo ${preds.length} partidos evaluados (mínimo ${MIN_MATCHES_FOR_VERDICT}). Esto NO es un veredicto: faltan datos, no hay evidencia a favor ni en contra del modelo.`,
        "Causas habituales: descargas incompletas (revisa la lista de archivos) o pocas temporadas (el modelo necesita unos 300 días de historia antes de predecir).",
      ],
    };
  }
  if (preds.length < 1500) reasons.push(`Muestra pequeña (${preds.length} partidos): cualquier conclusión es frágil.`);
  if (Number.isFinite(q.hi) && q.hi < 0) {
    verdict = "ventaja demostrada";
    reasons.push(`La mezcla supera a la cuota de cierre de Pinnacle en log-loss (diferencia ${q.mean.toFixed(4)}, IC95 % [${q.lo.toFixed(4)}, ${q.hi.toFixed(4)}]).`);
  } else {
    reasons.push(`Frente al cierre de Pinnacle la diferencia de log-loss es ${q.mean.toFixed(4)} (IC95 % [${q.lo.toFixed(4)}, ${q.hi.toFixed(4)}]): no es significativamente mejor.`);
  }
  const s = scenarios.b365.model;
  if (verdict !== "ventaja demostrada") {
    if (s.bets >= MIN_BETS_FOR_VERDICT && Number.isFinite(s.clv.lo) && s.clv.lo > 0) {
      verdict = "utilidad como filtro";
      reasons.push(`Las apuestas con valor a la cuota previa de Bet365 tienen CLV medio ${(s.clv.mean * 100).toFixed(2)} % (IC95 % [${(s.clv.lo * 100).toFixed(2)}, ${(s.clv.hi * 100).toFixed(2)}]) en ${s.bets} apuestas.`);
    } else if (s.bets < MIN_BETS_FOR_VERDICT) {
      reasons.push(`Solo ${s.bets} apuestas simuladas con Bet365 (mínimo ${MIN_BETS_FOR_VERDICT} para concluir).`);
    } else {
      reasons.push(`CLV medio con Bet365: ${(s.clv.mean * 100).toFixed(2)} % (IC95 % [${(s.clv.lo * 100).toFixed(2)}, ${(s.clv.hi * 100).toFixed(2)}]) en ${s.bets} apuestas: no es positivo con confianza.`);
    }
  }
  const base = scenarios.b365.baseline;
  if (base.bets > 0 && s.bets > 0) {
    const better = s.clv.mean >= base.clv.mean;
    reasons.push(
      `Referencia sin modelo (solo precio frente al consenso): CLV medio ${(base.clv.mean * 100).toFixed(2)} % en ${base.bets} apuestas. ` +
        `Con el modelo: ${(s.clv.mean * 100).toFixed(2)} % en ${s.bets}. ` +
        (better ? "El modelo no empeora el CLV frente a mirar solo el precio." : "El modelo REDUCE el CLV frente a mirar solo el precio: el valor está en comparar cuotas, no en el modelo."),
    );
  }
  return {
    matches: preds.length,
    leagues: [...new Set(preds.map((p) => p.league))].sort(),
    pinnacleShare: preds.length ? preds.filter((p) => p.benchSource === "pinnacle").length / preds.length : 0,
    quality, scenarios, calibration, verdict, verdictReasons: reasons,
  };
}

// ---------- Informe ----------
const f4 = (v: number) => (Number.isFinite(v) ? v.toFixed(4) : "—");
const pct = (v: number, d = 2) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)} %` : "—");
const ci = (c: CI, asPct = false) =>
  asPct ? `${pct(c.mean)} [${pct(c.lo)}, ${pct(c.hi)}]` : `${f4(c.mean)} [${f4(c.lo)}, ${f4(c.hi)}]`;

export function renderReport(r: GateResult, meta: { generatedAt: string; files: number }): string {
  const bet = (name: string, s: ScenarioResult) =>
    `| ${name} | con modelo (mezcla) | ${s.model.bets} | ${ci(s.model.clv, true)} | ${ci(s.model.roi, true)} | ${pct(s.model.hitRate, 1)} |\n` +
    `| ${name} | sin modelo (solo precio vs consenso) | ${s.baseline.bets} | ${ci(s.baseline.clv, true)} | ${ci(s.baseline.roi, true)} | ${pct(s.baseline.hitRate, 1)} |`;
  return `# Resultado del backtest (compuerta)

Generado: ${meta.generatedAt} · Archivos CSV: ${meta.files} · Partidos evaluados: **${r.matches}** · Ligas: ${r.leagues.join(", ") || "—"}
Referente: cuota de cierre de Pinnacle sin margen en el ${pct(r.pinnacleShare, 0)} de los partidos (el resto, promedio de cierre del mercado).

## Veredicto: **${r.verdict}**

${r.verdictReasons.map((x) => `- ${x}`).join("\n")}

## 1. Calidad de la probabilidad (1X2, menor es mejor)

| Fuente | Log-loss | Brier |
|---|---|---|
| Modelo puro | ${f4(r.quality.logLoss.model)} | ${f4(r.quality.brier.model)} |
| Mercado previo al cierre (sin margen) | ${f4(r.quality.logLoss.market)} | ${f4(r.quality.brier.market)} |
| Mezcla de producción | ${f4(r.quality.logLoss.blend)} | ${f4(r.quality.brier.blend)} |
| **Cierre de Pinnacle (referente)** | ${f4(r.quality.logLoss.bench)} | ${f4(r.quality.brier.bench)} |

- Mezcla − Pinnacle de cierre (log-loss, IC95 % bootstrap pareado): **${ci(r.quality.blendMinusBench)}**. Negativo = la mezcla es mejor.
- Mezcla − mercado previo (IC95 %): **${ci(r.quality.blendMinusMarket)}**. Negativo = el modelo aporta algo sobre el mercado que ya teníamos.

## 2. Utilidad como filtro: apostar a la cuota previa al cierre

CLV = cuota tomada × probabilidad justa de cierre de Pinnacle − 1. Un CLV medio positivo sostenido es la señal más fiable de ventaja; el ROI de pocas apuestas es ruido.

| Cuota tomada | Selección | Apuestas | CLV medio [IC95 %] | ROI medio [IC95 %] | Acierto |
|---|---|---|---|---|---|
${bet("Bet365", r.scenarios.b365)}
${bet("Máximo del mercado", r.scenarios.max)}

Filtros usados: los de producción (EV entre ${modelConfig.minEvPct} % y ${modelConfig.maxEvPct} %, cuota entre ${modelConfig.minOdds} y ${modelConfig.maxOdds}, brecha modelo-mercado ≤ ${modelConfig.maxModelMarketGap}, doble confirmación, precio atípico > ${modelConfig.maxMarketEvPct} % descartado).

## 3. Calibración de la mezcla

| Tramo | Selecciones | Predicho | Observado |
|---|---|---|---|
${r.calibration.map((b) => `| ${b.bin} | ${b.n} | ${pct(b.predicted, 1)} | ${pct(b.observed, 1)} |`).join("\n")}

## Lo que este informe NO demuestra

- Solo cubre el mercado 1X2. Los totales, hándicap, córners y tarjetas no están evaluados.
- Las cuotas «previas al cierre» de football-data se recogen días antes del partido (martes y viernes); sirven para medir CLV, no para simular apuestas en vivo.
- La cuota de Bet365 es la publicada en la fuente, no necesariamente tomable (límites, cierre de cuentas).
- Un resultado positivo con pocas apuestas puede ser suerte: mira el IC95 % y el tamaño de muestra. Un resultado negativo es igual de útil.
`;
}
