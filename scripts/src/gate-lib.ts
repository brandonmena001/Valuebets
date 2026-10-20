/**
 * Compuerta del proyecto: ¿el modelo aporta algo frente al mercado?
 *
 * Validación walk-forward (cada partido se predice solo con partidos anteriores) sobre CSV de
 * football-data.co.uk. Compara el modelo, la mezcla de producción y el mercado contra la cuota de
 * CIERRE de Pinnacle sin margen (el mejor referente gratuito de «probabilidad real»), y simula
 * apostar a la cuota previa al cierre de Bet365 los casos con valor para medir el CLV.
 */
import { ESS_HALF_WEIGHT, maxModelWeight, modelConfig } from "../../artifacts/api-server/src/model/config";
import { devigPower, median } from "../../artifacts/api-server/src/model/math";
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
  /** Cuotas previas al cierre por casa (todas las que traiga el CSV, salvo promedio/máximo/cierres). */
  books?: Record<string, P3>;
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

/**
 * Casas con triplete H/D/A en el encabezado (B365, BW, PS, WH, 1XB…). Se excluyen los agregados
 * (Max, Avg, BbMx/BbAv) y los cierres (prefijo terminado en C, p. ej. B365C o PSC).
 */
export function detectBooks(header: string[]): Array<{ name: string; idx: [number, number, number] }> {
  const set = new Set(header);
  const prefixes = new Set<string>();
  for (const h of header) {
    if (!h.endsWith("H")) continue;
    const p = h.slice(0, -1);
    if (p && set.has(`${p}D`) && set.has(`${p}A`)) prefixes.add(p);
  }
  const out: Array<{ name: string; idx: [number, number, number] }> = [];
  for (const p of prefixes) {
    if (p === "Max" || p === "Avg" || p.startsWith("BbMx") || p.startsWith("BbAv")) continue;
    if (p.endsWith("C") && p.length >= 3) continue; // cierre de esa casa
    out.push({ name: p, idx: [header.indexOf(`${p}H`), header.indexOf(`${p}D`), header.indexOf(`${p}A`)] });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Lee un CSV de football-data.co.uk por nombre de columna; ignora filas sin resultado. */
export function readRows(text: string, league: string, season: string): Row[] {
  const rows = parseCsv(text);
  const header = rows[0]?.map((h) => h.trim());
  if (!header) return [];
  const col = (name: string) => header.indexOf(name);
  const [iDate, iTime, iHome, iAway, iHg, iAg] = ["Date", "Time", "HomeTeam", "AwayTeam", "FTHG", "FTAG"].map(col) as number[];
  if ([iDate, iHome, iAway, iHg, iAg].some((i) => i! < 0)) return [];
  const bookCols = detectBooks(header);
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
    const books: Record<string, P3> = {};
    for (const b of bookCols) {
      const v = b.idx.map((i) => Number(r[i] ?? ""));
      if (v.every((x) => Number.isFinite(x) && x > 1)) books[b.name] = v as P3;
    }
    if (Object.keys(books).length) row.books = books;
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
/** model = apuestas con valor según la mezcla; baseline = solo precio vs consenso; all = TODAS las selecciones (referencia de cuánto vale un CLV). */
export type ScenarioResult = { model: BetStats; baseline: BetStats; all: BetStats };

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
  /** true si mezclar el modelo EMPEORA significativamente al mercado previo (IC95 % por encima de 0). */
  modelHurts: boolean;
  verdict: "ventaja demostrada" | "utilidad como filtro" | "sin ventaja demostrada" | "datos insuficientes";
  verdictReasons: string[];
};

const MIN_BETS_FOR_VERDICT = 200;
/** Por debajo de esto no se emite veredicto: con pocos partidos «sin ventaja» sería una conclusión falsa. */
const MIN_MATCHES_FOR_VERDICT = 1000;

type BetMode = "model" | "baseline" | "all";

function simulateBets(preds: Prediction[], source: "b365" | "max", mode: BetMode): BetStats {
  const cfg = modelConfig;
  const clvs: number[] = [];
  const rois: number[] = [];
  for (const p of preds) {
    const odds = p[source];
    if (!odds) continue;
    for (let k = 0; k < 3; k += 1) {
      const price = odds[k]!;
      if (price < cfg.minOdds || price > cfg.maxOdds) continue;
      if (mode !== "all") {
        const marketEv = (p.market[k]! * price - 1) * 100;
        if (marketEv > cfg.maxMarketEvPct) continue; // cuota atípica: se descarta, como en producción
        if (mode === "model") {
          const evBlend = (p.blend[k]! * price - 1) * 100;
          if (evBlend < cfg.minEvPct || evBlend > cfg.maxEvPct) continue;
          if (p.raw[k]! * price < 1) continue; // doble confirmación
          if (p.raw[k]! - p.market[k]! > cfg.maxModelMarketGap) continue;
        } else if (marketEv < cfg.minEvPct) {
          continue; // sin modelo: solo precio frente al consenso del mercado
        }
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
    b365: { model: simulateBets(preds, "b365", "model"), baseline: simulateBets(preds, "b365", "baseline"), all: simulateBets(preds, "b365", "all") },
    max: { model: simulateBets(preds, "max", "model"), baseline: simulateBets(preds, "max", "baseline"), all: simulateBets(preds, "max", "all") },
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
  const qm = quality.blendMinusMarket;
  const modelHurts = Number.isFinite(qm.lo) && qm.lo > 0;
  const common = {
    matches: preds.length,
    leagues: [...new Set(preds.map((p) => p.league))].sort(),
    pinnacleShare: preds.length ? preds.filter((p) => p.benchSource === "pinnacle").length / preds.length : 0,
    quality, scenarios, calibration, modelHurts,
  };
  if (preds.length < MIN_MATCHES_FOR_VERDICT) {
    return {
      ...common,
      verdict: "datos insuficientes",
      verdictReasons: [
        `Solo ${preds.length} partidos evaluados (mínimo ${MIN_MATCHES_FOR_VERDICT}). Esto NO es un veredicto: faltan datos, no hay evidencia a favor ni en contra del modelo.`,
        "Causas habituales: descargas incompletas (revisa la lista de archivos) o pocas temporadas (el modelo necesita unos 300 días de historia antes de predecir).",
      ],
    };
  }
  const f = (v: number) => v.toFixed(4);
  const range = (c: CI) => `IC95 % [${f(c.lo)}, ${f(c.hi)}]`;
  if (preds.length < 1500) reasons.push(`Muestra pequeña (${preds.length} partidos): cualquier conclusión es frágil.`);
  if (Number.isFinite(q.hi) && q.hi < 0) {
    verdict = "ventaja demostrada";
    reasons.push(`La mezcla supera a la cuota de cierre de Pinnacle en log-loss (diferencia ${f(q.mean)}, ${range(q)}).`);
  } else if (Number.isFinite(q.lo) && q.lo > 0) {
    reasons.push(`La mezcla es PEOR que el cierre de Pinnacle: log-loss +${f(q.mean)} (${range(q)}).`);
  } else {
    reasons.push(`Frente al cierre de Pinnacle la diferencia de log-loss es ${f(q.mean)} (${range(q)}): no se distingue.`);
  }
  if (modelHurts) {
    reasons.push(`También es PEOR que el mercado previo (+${f(qm.mean)}, ${range(qm)}): mezclar el modelo EMPEORA la probabilidad que ya teníamos; el modelo no aporta información.`);
  } else if (Number.isFinite(qm.hi) && qm.hi < 0) {
    reasons.push(`Mejora al mercado previo (${f(qm.mean)}, ${range(qm)}): el modelo aporta información.`);
  } else {
    reasons.push(`Frente al mercado previo no se distingue (${f(qm.mean)}, ${range(qm)}).`);
  }
  const s = scenarios.b365.model;
  const pctText = (v: number) => `${(v * 100).toFixed(2)} %`;
  const clvText = (c: CI) => `${pctText(c.mean)} (IC95 % [${pctText(c.lo)}, ${pctText(c.hi)}])`;
  if (verdict !== "ventaja demostrada") {
    if (s.bets >= MIN_BETS_FOR_VERDICT && Number.isFinite(s.clv.lo) && s.clv.lo > 0) {
      verdict = "utilidad como filtro";
      reasons.push(`Las apuestas con valor a la cuota previa de Bet365 tienen CLV medio ${clvText(s.clv)} en ${s.bets} apuestas.`);
    } else if (s.bets < MIN_BETS_FOR_VERDICT) {
      reasons.push(`Solo ${s.bets} apuestas simuladas con Bet365 (mínimo ${MIN_BETS_FOR_VERDICT} para concluir).`);
    } else {
      reasons.push(`CLV medio con Bet365: ${clvText(s.clv)} en ${s.bets} apuestas: no es positivo con confianza.`);
    }
  }
  // ¿El filtro del modelo elige mejor que apostar a todo? (referencia indispensable para leer un CLV)
  for (const [label, sc] of [["de Bet365", scenarios.b365], ["máxima del mercado", scenarios.max]] as const) {
    if (sc.model.bets >= 30 && sc.all.bets >= 30) {
      const diff = sc.model.clv.mean - sc.all.clv.mean;
      const se = Math.hypot((sc.model.clv.hi - sc.model.clv.lo) / 3.92, (sc.all.clv.hi - sc.all.clv.lo) / 3.92);
      reasons.push(
        `Apostar TODAS las selecciones a la cuota ${label} da CLV ${pctText(sc.all.clv.mean)}; el filtro del modelo da ${pctText(sc.model.clv.mean)} en ${sc.model.bets} apuestas: ` +
          `efecto del filtro ${diff >= 0 ? "+" : ""}${(diff * 100).toFixed(2)} puntos (±${(1.96 * se * 100).toFixed(2)}).`,
      );
    }
  }
  const base = scenarios.max.baseline;
  if (base.bets < 30) {
    reasons.push(`Sin modelo (solo precio frente al consenso) hay apenas ${base.bets} apuestas con el máximo del mercado: muestra insuficiente para comparar.`);
  }
  return { ...common, verdict, verdictReasons: reasons };
}

// ---------- Modo referencia: casas entre sí, sin modelo ----------
export type ReferenceStats = { threshold: number; bets: number; per1000: number; clv: CI; roi: CI };
export type ReferenceResult = {
  rowsAvailable: number;
  matches: number;
  minBooks: number;
  capPct: number;
  /** Mejor precio de cada resultado, sin ningún filtro de valor. */
  bestPriceAll: BetStats;
  sweep: ReferenceStats[];
  perBook: Array<{ book: string; matches: number; clvAll: number; selectedBets: number; selectedClv: number }>;
  headline: { threshold: number; verdict: "señal de precio con CLV positivo" | "volumen insuficiente" | "sin señal de precio"; reason: string };
};

/**
 * Sin modelo: para cada partido y resultado se toma el MEJOR precio entre las casas y se compara con el
 * consenso (mediana de probabilidades sin margen) de las DEMÁS casas. El CLV se mide frente al cierre de
 * Pinnacle. Es exactamente lo que haría el producto si se limita a comparar cuotas.
 */
export function referenceBacktest(
  rows: Row[],
  opts: { minBooks?: number; thresholds?: number[]; capPct?: number; headline?: number } = {},
): ReferenceResult {
  const minBooks = opts.minBooks ?? 4;
  const thresholds = opts.thresholds ?? [1, 2, 3, 4, 5, 6, 8];
  const capPct = opts.capPct ?? 15;
  const headline = opts.headline ?? 4;
  const cfg = modelConfig;
  type Cand = { book: string; ev: number; clv: number; roi: number };
  const cands: Cand[] = [];
  const perBook = new Map<string, { n: number; sum: number }>();
  let used = 0;
  for (const r of rows) {
    const bench = devig3(r.pinClose) ?? devig3(r.avgClose);
    if (!bench || !r.books) continue;
    const entries = Object.entries(r.books)
      .map(([name, odds]) => ({ name, odds, fair: devig3(odds) }))
      .filter((e): e is { name: string; odds: P3; fair: P3 } => e.fair !== null);
    if (entries.length < minBooks) continue;
    used += 1;
    const y = r.hg > r.ag ? 0 : r.hg === r.ag ? 1 : 2;
    for (const e of entries) {
      for (let k = 0; k < 3; k += 1) {
        if (e.odds[k]! < cfg.minOdds || e.odds[k]! > cfg.maxOdds) continue;
        const acc = perBook.get(e.name) ?? { n: 0, sum: 0 };
        acc.n += 1;
        acc.sum += e.odds[k]! * bench[k]! - 1;
        perBook.set(e.name, acc);
      }
    }
    for (let k = 0; k < 3; k += 1) {
      let best = entries[0]!;
      for (const e of entries) if (e.odds[k]! > best.odds[k]!) best = e;
      const price = best.odds[k]!;
      if (price < cfg.minOdds || price > cfg.maxOdds) continue;
      const others = entries.filter((e) => e !== best);
      if (others.length < 3) continue;
      const med = [0, 1, 2].map((j) => median(others.map((o) => o.fair[j]!)));
      const consensus = med[k]! / (med[0]! + med[1]! + med[2]!);
      cands.push({ book: best.name, ev: price * consensus - 1, clv: price * bench[k]! - 1, roi: y === k ? price - 1 : -1 });
    }
  }
  const stat = (list: Cand[]) => ({ clv: bootstrapMean(list.map((c) => c.clv)), roi: bootstrapMean(list.map((c) => c.roi), 2000, 23) });
  const pick = (t: number) => cands.filter((c) => c.ev * 100 >= t && c.ev * 100 <= capPct);
  const sweep: ReferenceStats[] = thresholds.map((t) => {
    const list = pick(t);
    return { threshold: t, bets: list.length, per1000: used ? (list.length / used) * 1000 : 0, ...stat(list) };
  });
  const all = stat(cands);
  const bestPriceAll: BetStats = { bets: cands.length, clv: all.clv, roi: all.roi, hitRate: cands.length ? cands.filter((c) => c.roi > 0).length / cands.length : NaN };
  const selected = pick(headline);
  const byBook = new Map<string, { n: number; sum: number }>();
  for (const c of selected) {
    const acc = byBook.get(c.book) ?? { n: 0, sum: 0 };
    acc.n += 1;
    acc.sum += c.clv;
    byBook.set(c.book, acc);
  }
  const perBookRows = [...perBook.entries()]
    .map(([book, acc]) => ({
      book, matches: Math.round(acc.n / 3), clvAll: acc.sum / acc.n,
      selectedBets: byBook.get(book)?.n ?? 0, selectedClv: byBook.get(book) ? byBook.get(book)!.sum / byBook.get(book)!.n : NaN,
    }))
    .sort((a, b) => b.selectedBets - a.selectedBets || b.matches - a.matches);
  const h = sweep.find((x) => x.threshold === headline) ?? sweep[0]!;
  let verdict: ReferenceResult["headline"]["verdict"] = "sin señal de precio";
  let reason = `Con umbral ${headline} %: ${h.bets} apuestas, CLV medio ${(h.clv.mean * 100).toFixed(2)} % (IC95 % [${(h.clv.lo * 100).toFixed(2)}, ${(h.clv.hi * 100).toFixed(2)}]).`;
  if (h.bets < MIN_BETS_FOR_VERDICT) {
    verdict = "volumen insuficiente";
    reason += ` Menos de ${MIN_BETS_FOR_VERDICT} apuestas: no se puede concluir.`;
  } else if (Number.isFinite(h.clv.lo) && h.clv.lo > 0) {
    verdict = "señal de precio con CLV positivo";
  }
  return { rowsAvailable: rows.length, matches: used, minBooks, capPct, bestPriceAll, sweep, perBook: perBookRows, headline: { threshold: headline, verdict, reason } };
}

// ---------- Informe ----------
function referenceSection(ref?: ReferenceResult): string {
  if (!ref) return "";
  const rows = ref.sweep.map((x) => `| ≥ ${x.threshold} % (hasta ${ref.capPct} %) | ${x.bets} | ${x.per1000.toFixed(1)} | ${ci(x.clv, true)} | ${ci(x.roi, true)} |`).join("\n");
  const books = ref.perBook.map((b) => `| ${b.book} | ${b.matches} | ${pct(b.clvAll)} | ${b.selectedBets} | ${pct(b.selectedClv)} |`).join("\n");
  return `## 4. Modo referencia: comparar las casas entre sí (sin modelo)

Para cada partido y resultado se toma el **mejor precio** entre las casas y se compara con el consenso (mediana de probabilidades sin margen) de las **demás** casas; el CLV se mide frente al cierre de Pinnacle. Partidos usados: ${ref.matches} de ${ref.rowsAvailable} (mínimo ${ref.minBooks} casas con cuotas y referente de cierre).

**Conclusión del modo referencia: ${ref.headline.verdict}.** ${ref.headline.reason}

| Umbral de valor (EV vs consenso) | Apuestas | Por 1000 partidos | CLV medio [IC95 %] | ROI medio [IC95 %] |
|---|---|---|---|---|
${rows}
| **Mejor precio, sin filtro** | ${ref.bestPriceAll.bets} | — | ${ci(ref.bestPriceAll.clv, true)} | ${ci(ref.bestPriceAll.roi, true)} |

El umbral es descriptivo: el veredicto usa solo el umbral de ${ref.headline.threshold} % fijado de antemano, para no elegir a posteriori el que mejor salga.

| Casa | Partidos | CLV de apostar SIEMPRE en esa casa | Veces mejor precio (umbral ${ref.headline.threshold} %) | CLV de esas apuestas |
|---|---|---|---|---|
${books}`;
}

const f4 = (v: number) => (Number.isFinite(v) ? v.toFixed(4) : "—");
const pct = (v: number, d = 2) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)} %` : "—");
const ci = (c: CI, asPct = false) =>
  asPct ? `${pct(c.mean)} [${pct(c.lo)}, ${pct(c.hi)}]` : `${f4(c.mean)} [${f4(c.lo)}, ${f4(c.hi)}]`;

export function renderReport(r: GateResult, meta: { generatedAt: string; files: number }, reference?: ReferenceResult): string {
  const bet = (name: string, s: ScenarioResult) =>
    `| ${name} | con modelo (mezcla) | ${s.model.bets} | ${ci(s.model.clv, true)} | ${ci(s.model.roi, true)} | ${pct(s.model.hitRate, 1)} |\n` +
    `| ${name} | sin modelo (solo precio vs consenso) | ${s.baseline.bets} | ${ci(s.baseline.clv, true)} | ${ci(s.baseline.roi, true)} | ${pct(s.baseline.hitRate, 1)} |\n` +
    `| ${name} | **todas las selecciones (sin filtro)** | ${s.all.bets} | ${ci(s.all.clv, true)} | ${ci(s.all.roi, true)} | ${pct(s.all.hitRate, 1)} |`;
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

${referenceSection(reference)}

## Lo que este informe NO demuestra

- Solo cubre el mercado 1X2. Los totales, hándicap, córners y tarjetas no están evaluados.
- Las cuotas «previas al cierre» de football-data se recogen días antes del partido (martes y viernes); sirven para medir CLV, no para simular apuestas en vivo.
- La cuota de Bet365 es la publicada en la fuente, no necesariamente tomable (límites, cierre de cuentas).
- Un resultado positivo con pocas apuestas puede ser suerte: mira el IC95 % y el tamaño de muestra. Un resultado negativo es igual de útil.
`;
}
