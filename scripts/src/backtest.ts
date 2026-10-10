/**
 * Backtest walk-forward del 1X2: modelo puro vs mercado sin margen vs mezcla.
 *
 * Uso (desde la raíz del repo):
 *   pnpm --filter @workspace/scripts exec tsx src/backtest.ts <carpeta|archivo.csv> ... [opciones]
 *
 * Archivos: CSV de football-data.co.uk. La liga y la temporada se toman del nombre
 * (E0_2324.csv, SP1-2223.csv) o de la ruta (mmz4281/2324/E0.csv).
 * Opciones: --step-days=7  --burnin-days=300  --holdout=0.35  --out=ruta.md
 *
 * Regla anti-fuga: cada partido se predice con un modelo ajustado SOLO con partidos
 * anteriores al inicio de su bloque (--step-days). Nunca se usa el resultado propio.
 */
import fs from "node:fs";
import path from "node:path";
import { ESS_HALF_WEIGHT, maxModelWeight, modelConfig } from "../../artifacts/api-server/src/model/config";
import { devigPower, sum } from "../../artifacts/api-server/src/model/math";
import { normalizeName, resolveName } from "../../artifacts/api-server/src/model/names";
import { fitLeagueModel, type HistoryMatch } from "../../artifacts/api-server/src/model/predict";
import { expectedRates, resultProbs, scoreMatrix } from "../../artifacts/api-server/src/model/strength";
import { parseCsv } from "../../artifacts/api-server/src/services/football-data-parse";

type P3 = [number, number, number]; // local, empate, visitante
type Row = {
  league: string;
  season: string;
  kickoff: Date;
  home: string;
  away: string;
  hg: number;
  ag: number;
  /** Cuotas de cierre (1X2) por fuente. */
  odds: { avg?: P3; b365?: P3; max?: P3 };
};

const DAY = 86_400_000;

// ---------- Lectura de CSV ----------
function parseDate(dateText: string, timeText: string): Date | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(dateText.trim());
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  const t = /^(\d{1,2}):(\d{2})/.exec(timeText.trim());
  const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1]), t ? Number(t[1]) : 15, t ? Number(t[2]) : 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function leagueSeasonFromPath(file: string): { league: string; season: string } {
  const parts = path.resolve(file).split(path.sep);
  const stem = path.basename(file).replace(/\.csv$/i, "");
  const parent = parts.at(-2) ?? "";
  if (/^\d{4}$/.test(parent)) return { league: stem, season: parent };
  const m = /^([A-Za-z0-9]+)[_\- ](\d{4})/.exec(stem);
  if (m) return { league: m[1]!, season: m[2]! };
  return { league: stem, season: "0000" };
}

const ODDS_COLS: Array<{ key: "avg" | "b365" | "max"; sets: string[][] }> = [
  { key: "avg", sets: [["AvgCH", "AvgCD", "AvgCA"], ["AvgH", "AvgD", "AvgA"], ["BbAvH", "BbAvD", "BbAvA"]] },
  { key: "b365", sets: [["B365CH", "B365CD", "B365CA"], ["B365H", "B365D", "B365A"]] },
  { key: "max", sets: [["MaxCH", "MaxCD", "MaxCA"], ["MaxH", "MaxD", "MaxA"], ["BbMxH", "BbMxD", "BbMxA"]] },
];

export function readRows(text: string, league: string, season: string): Row[] {
  const rows = parseCsv(text);
  const header = rows[0]?.map((h) => h.trim());
  if (!header) return [];
  const col = (n: string) => header.indexOf(n);
  const [iDate, iTime, iH, iA, iHG, iAG] = ["Date", "Time", "HomeTeam", "AwayTeam", "FTHG", "FTAG"].map(col) as number[];
  if (iDate! < 0 || iH! < 0 || iA! < 0 || iHG! < 0 || iAG! < 0) return [];
  const out: Row[] = [];
  for (const r of rows.slice(1)) {
    const kickoff = parseDate(r[iDate!] ?? "", iTime! >= 0 ? r[iTime!] ?? "" : "");
    const hg = Number(r[iHG!]);
    const ag = Number(r[iAG!]);
    const home = r[iH!]?.trim();
    const away = r[iA!]?.trim();
    if (!kickoff || !home || !away || !Number.isInteger(hg) || !Number.isInteger(ag) || r[iHG!]?.trim() === "") continue;
    const odds: Row["odds"] = {};
    for (const { key, sets } of ODDS_COLS) {
      for (const set of sets) {
        const idxs = set.map(col);
        if (idxs.some((i) => i < 0)) continue;
        const vals = idxs.map((i) => Number(r[i] ?? ""));
        if (vals.every((v) => v > 1)) {
          odds[key] = vals as P3;
          break;
        }
      }
    }
    out.push({ league, season, kickoff, home, away, hg, ag, odds });
  }
  return out;
}

// ---------- Métricas ----------
function normalize(p: P3): P3 {
  const t = p[0] + p[1] + p[2];
  return [p[0] / t, p[1] / t, p[2] / t];
}
function devig(o: P3 | undefined): P3 | null {
  if (!o) return null;
  const fair = devigPower(o);
  if (fair) return fair as P3;
  // Cuotas "máximas" pueden sumar < 1 de probabilidad implícita: se normaliza.
  return normalize(o.map((v) => 1 / v) as P3);
}
const outcomeIdx = (r: Row): 0 | 1 | 2 => (r.hg > r.ag ? 0 : r.hg === r.ag ? 1 : 2);
function logLoss(p: P3, y: number): number {
  return -Math.log(Math.min(1 - 1e-9, Math.max(1e-9, p[y]!)));
}
function brier(p: P3, y: number): number {
  return sum(p.map((v, k) => (v - (k === y ? 1 : 0)) ** 2));
}
type Score = { ll: number; br: number; n: number };
function score(items: Array<{ p: P3; y: number }>): Score {
  if (!items.length) return { ll: NaN, br: NaN, n: 0 };
  return {
    ll: sum(items.map((i) => logLoss(i.p, i.y))) / items.length,
    br: sum(items.map((i) => brier(i.p, i.y))) / items.length,
    n: items.length,
  };
}

// ---------- Walk-forward ----------
type Combo = { halfLife: number; prior: number };
type Evaluated = { row: Row; y: number; market: P3; raw: Map<string, { p: P3; ess: number }> };

const key = (c: Combo) => `${c.halfLife}|${c.prior}`;

function toHistory(rows: Row[]): HistoryMatch[] {
  return rows.map((r, i) => ({
    id: i + 1,
    leagueCode: r.league,
    homeTeam: r.home,
    awayTeam: r.away,
    kickoff: r.kickoff,
    homeScore: r.hg,
    awayScore: r.ag,
    homeCorners: null, awayCorners: null, homeYellowCards: null, awayYellowCards: null,
    homeRedCards: null, awayRedCards: null, homeShotsOnTarget: null, awayShotsOnTarget: null,
  }));
}

export function walkForward(
  rows: Row[],
  combos: Combo[],
  opts: { stepDays: number; burninDays: number },
): Evaluated[] {
  const sorted = [...rows].sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());
  const history = toHistory(sorted);
  const t0 = sorted[0]!.kickoff.getTime();
  const evaluated: Evaluated[] = [];
  let i = 0;
  while (i < sorted.length) {
    const blockStart = new Date(t0 + Math.floor((sorted[i]!.kickoff.getTime() - t0) / (opts.stepDays * DAY)) * opts.stepDays * DAY);
    let j = i;
    while (j < sorted.length && sorted[j]!.kickoff.getTime() < blockStart.getTime() + opts.stepDays * DAY) j += 1;
    const block = sorted.slice(i, j);
    const prior = history.slice(0, i); // solo partidos estrictamente anteriores a este bloque
    const lastPrior = prior.at(-1)?.kickoff.getTime() ?? 0;
    const leagues = [...new Set(block.map((r) => r.league))];
    const models = new Map<string, ReturnType<typeof fitLeagueModel>>();
    if (blockStart.getTime() - t0 >= opts.burninDays * DAY && lastPrior < blockStart.getTime() + 1) {
      for (const lg of leagues) {
        for (const c of combos) {
          models.set(`${lg}|${key(c)}`, fitLeagueModel(prior, lg, "goals", blockStart, { halfLifeDays: c.halfLife, priorGames: c.prior }));
        }
      }
    }
    for (const row of block) {
      const market = devig(row.odds.avg ?? row.odds.b365);
      if (!market || models.size === 0) continue;
      const raw = new Map<string, { p: P3; ess: number }>();
      let ok = true;
      for (const c of combos) {
        const lm = models.get(`${row.league}|${key(c)}`);
        if (!lm) { ok = false; break; }
        const h = resolveName(row.home, lm.teams) ?? (lm.teams.includes(normalizeName(row.home)) ? normalizeName(row.home) : null);
        const a = resolveName(row.away, lm.teams) ?? (lm.teams.includes(normalizeName(row.away)) ? normalizeName(row.away) : null);
        if (!h || !a) { ok = false; break; }
        const rates = expectedRates(lm.model, h, a);
        if (!rates || rates.ess < modelConfig.minTeamEss) { ok = false; break; }
        const rp = resultProbs(scoreMatrix(rates.lh, rates.la, lm.model.rho));
        raw.set(key(c), { p: [rp.home, rp.draw, rp.away], ess: rates.ess });
      }
      if (ok) evaluated.push({ row, y: outcomeIdx(row), market, raw });
    }
    i = j;
  }
  return evaluated;
}

function blend(raw: P3, market: P3, ess: number, maxW: number, essHalf: number): P3 {
  const w = maxW * (ess / (ess + essHalf));
  return normalize([0, 1, 2].map((k) => w * raw[k]! + (1 - w) * market[k]!) as P3);
}

// ---------- Simulación de apuestas (filtros de predict.ts) ----------
type BetStats = { bets: number; roiPct: number; seRoiPct: number };
function simulateBets(ev: Evaluated[], c: Combo, maxW: number, essHalf: number, gap: number): BetStats {
  const returns: number[] = [];
  for (const e of ev) {
    const priceSrc = e.row.odds.max ?? e.row.odds.b365;
    const r = e.raw.get(key(c))!;
    if (!priceSrc) continue;
    const p = blend(r.p, e.market, r.ess, maxW, essHalf);
    for (let k = 0; k < 3; k += 1) {
      const odds = priceSrc[k]!;
      const evPct = (p[k]! * odds - 1) * 100;
      const marketEv = (e.market[k]! * odds - 1) * 100;
      if (odds < modelConfig.minOdds || odds > modelConfig.maxOdds) continue;
      if (evPct < modelConfig.minEvPct || evPct > modelConfig.maxEvPct) continue;
      if (marketEv > modelConfig.maxMarketEvPct) continue;
      if (r.p[k]! * odds < 1) continue;
      if (r.p[k]! - e.market[k]! > gap) continue;
      returns.push(e.y === k ? odds - 1 : -1);
    }
  }
  const n = returns.length;
  if (!n) return { bets: 0, roiPct: NaN, seRoiPct: NaN };
  const mean = sum(returns) / n;
  const variance = n > 1 ? sum(returns.map((x) => (x - mean) ** 2)) / (n - 1) : 0;
  return { bets: n, roiPct: mean * 100, seRoiPct: Math.sqrt(variance / n) * 100 };
}

// ---------- Informe ----------
const f4 = (v: number) => (Number.isFinite(v) ? v.toFixed(4) : "n/d");
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : "n/d");

export function buildReport(rows: Row[], opts: { stepDays: number; burninDays: number; holdout: number }): string {
  const halfLives = [90, 180, 365, 730];
  const priors = [2, 5, 10, 20];
  const maxWs = [0, 0.1, 0.2, 0.35, 0.5, 0.75, 1];
  const essHalves = [4, 8, 16];
  const combos: Combo[] = halfLives.flatMap((halfLife) => priors.map((prior) => ({ halfLife, prior })));
  const ev = walkForward(rows, combos, opts);
  const lines: string[] = [];
  const out = (s = "") => lines.push(s);
  const leagues = [...new Set(rows.map((r) => r.league))];
  const withOdds = rows.filter((r) => r.odds.avg || r.odds.b365).length;
  out(`# Backtest walk-forward 1X2`);
  out();
  out(`- Partidos leídos: ${rows.length} (${leagues.join(", ")}); con cuotas: ${withOdds}.`);
  out(`- Partidos evaluados (tras ${opts.burninDays} días de rodaje y con modelo disponible en todas las combinaciones): ${ev.length}.`);
  out(`- Re-ajuste cada ${opts.stepDays} días usando solo partidos anteriores. Mercado = cuota de cierre Avg (o B365) sin margen (potencia).`);
  if (ev.length < 300) {
    out();
    out(`**ATENCIÓN: ${ev.length} partidos evaluados es muy poco; no saques conclusiones (el error estándar de log-loss es grande).**`);
    if (!ev.length) return lines.join("\n");
  }
  const cut = Math.floor(ev.length * (1 - opts.holdout));
  const train = ev.slice(0, cut);
  const test = ev.slice(cut);
  out(`- Entrenamiento (selección de parámetros): ${train.length}; prueba fuera de muestra (posterior en el tiempo): ${test.length}.`);

  const def: Combo = { halfLife: modelConfig.halfLifeDays, prior: modelConfig.priorGames };
  const defKey = key(combos.find((c) => c.halfLife === def.halfLife && c.prior === def.prior) ?? combos[0]!);
  const defCombo = combos.find((c) => key(c) === defKey)!;
  const defW: number = maxModelWeight["match-result"];

  const evalSet = (set: Evaluated[], c: Combo, w: number, h: number) =>
    score(set.map((e) => ({ p: blend(e.raw.get(key(c))!.p, e.market, e.raw.get(key(c))!.ess, w, h), y: e.y })));
  const pureSet = (set: Evaluated[], c: Combo) => score(set.map((e) => ({ p: e.raw.get(key(c))!.p, y: e.y })));
  const marketSet = (set: Evaluated[]) => score(set.map((e) => ({ p: e.market, y: e.y })));
  const bookSet = (set: Evaluated[], src: "b365" | "max") =>
    score(set.flatMap((e) => { const d = devig(e.row.odds[src]); return d ? [{ p: d, y: e.y }] : []; }));

  // Mejor configuración por log-loss en entrenamiento
  let best = { c: defCombo, w: defW, h: ESS_HALF_WEIGHT, ll: Infinity };
  for (const c of combos) for (const w of maxWs) for (const h of essHalves) {
    const s = evalSet(train, c, w, h);
    if (s.ll < best.ll) best = { c, w, h, ll: s.ll };
  }

  const table = (title: string, set: Evaluated[]) => {
    out();
    out(`## ${title} (n=${set.length})`);
    out();
    out(`| Variante | log-loss | Brier (3 clases) |`);
    out(`|---|---|---|`);
    const row = (name: string, s: Score) => out(`| ${name} | ${f4(s.ll)} | ${f4(s.br)} |`);
    row(`(b) Mercado sin margen (Avg/B365)`, marketSet(set));
    row(`(a) Modelo puro (hl=${defCombo.halfLife}, prior=${defCombo.prior})`, pureSet(set, defCombo));
    row(`(c) Mezcla actual (maxW=${defW}, essHalf=${ESS_HALF_WEIGHT})`, evalSet(set, defCombo, defW, ESS_HALF_WEIGHT));
    row(`(c') Mezcla mejor en entrenamiento (hl=${best.c.halfLife}, prior=${best.c.prior}, maxW=${best.w}, essHalf=${best.h})`, evalSet(set, best.c, best.w, best.h));
    const b365 = bookSet(set, "b365");
    if (b365.n) row(`Ref.: B365 sin margen`, b365);
  };
  table("Entrenamiento", train);
  if (test.length) table("Prueba fuera de muestra", test);

  const sensitivity = (title: string, vary: Array<{ label: string; c: Combo; w: number; h: number }>) => {
    out();
    out(`### ${title}`);
    out();
    out(`| Valor | log-loss entren. | log-loss prueba |`);
    out(`|---|---|---|`);
    for (const v of vary) out(`| ${v.label} | ${f4(evalSet(train, v.c, v.w, v.h).ll)} | ${f4(test.length ? evalSet(test, v.c, v.w, v.h).ll : NaN)} |`);
  };
  out();
  out(`## Sensibilidad de la mezcla (resto de parámetros en el valor actual)`);
  sensitivity("maxModelWeight (match-result)", maxWs.map((w) => ({ label: String(w), c: defCombo, w, h: ESS_HALF_WEIGHT })));
  sensitivity("ESS_HALF_WEIGHT", essHalves.map((h) => ({ label: String(h), c: defCombo, w: defW, h })));
  sensitivity("halfLifeDays (modelo puro dentro de la mezcla)", halfLives.map((hl) => ({ label: String(hl), c: { halfLife: hl, prior: defCombo.prior }, w: defW, h: ESS_HALF_WEIGHT })));
  sensitivity("priorGames", priors.map((pg) => ({ label: String(pg), c: { halfLife: defCombo.halfLife, prior: pg }, w: defW, h: ESS_HALF_WEIGHT })));

  // Calibración del modelo puro (deciles de la prob. del favorito local)
  out();
  out(`## Calibración del modelo puro (todas las selecciones, por tramo de probabilidad; n=${ev.length * 3})`);
  out();
  out(`| Tramo | n | Prob. media | Frecuencia real |`);
  out(`|---|---|---|---|`);
  const bins = Array.from({ length: 8 }, () => ({ n: 0, p: 0, hit: 0 }));
  for (const e of ev) {
    const p = e.raw.get(key(defCombo))!.p;
    for (let k = 0; k < 3; k += 1) {
      const b = bins[Math.min(7, Math.floor(p[k]! * 8))]!;
      b.n += 1; b.p += p[k]!; b.hit += e.y === k ? 1 : 0;
    }
  }
  bins.forEach((b, i) => { if (b.n) out(`| ${(i / 8).toFixed(3)}–${((i + 1) / 8).toFixed(3)} | ${b.n} | ${f4(b.p / b.n)} | ${f4(b.hit / b.n)} |`); });

  // Apuestas simuladas por umbral de discrepancia
  out();
  out(`## Apuestas simuladas por maxModelMarketGap (filtros de predict.ts; precio = cuota máxima de cierre)`);
  out();
  out(`Config: mezcla actual (hl=${defCombo.halfLife}, prior=${defCombo.prior}, maxW=${defW}, essHalf=${ESS_HALF_WEIGHT}). Stake plano de 1 unidad. ROI ± error estándar.`);
  out();
  out(`| Gap máx. | Apuestas (entren.) | ROI % entren. | Apuestas (prueba) | ROI % prueba |`);
  out(`|---|---|---|---|---|`);
  for (const gap of [0.03, 0.05, 0.08, 0.12, 1]) {
    const a = simulateBets(train, defCombo, defW, ESS_HALF_WEIGHT, gap);
    const b = simulateBets(test, defCombo, defW, ESS_HALF_WEIGHT, gap);
    const cell = (s: BetStats) => (s.bets ? `${f2(s.roiPct)} ± ${f2(s.seRoiPct)}` : "n/d");
    out(`| ${gap === 1 ? "sin límite" : gap} | ${a.bets} | ${cell(a)} | ${b.bets} | ${cell(b)} |`);
  }
  out();
  out(`## Lectura`);
  out();
  const tPure = test.length ? pureSet(test, defCombo).ll : pureSet(train, defCombo).ll;
  const tMkt = test.length ? marketSet(test).ll : marketSet(train).ll;
  const tBlend = test.length ? evalSet(test, defCombo, defW, ESS_HALF_WEIGHT).ll : evalSet(train, defCombo, defW, ESS_HALF_WEIGHT).ll;
  const tBest = test.length ? evalSet(test, best.c, best.w, best.h).ll : best.ll;
  out(`- Fuera de muestra: mercado ${f4(tMkt)}, modelo puro ${f4(tPure)}, mezcla actual ${f4(tBlend)}, mezcla ajustada ${f4(tBest)} (menor es mejor).`);
  out(`- Una diferencia de log-loss menor a ~0.002 con n < 2000 no es distinguible del azar. Un ROI debe compararse con su error estándar; aquí casi nunca será significativo.`);
  out(`- Cuotas de CIERRE: el mercado de cierre es más preciso que el que ve el sistema en producción (horas antes), así que el mercado se ve mejor aquí de lo que será y la mezcla pesa a favor del mercado de forma optimista.`);
  return lines.join("\n");
}

function collectFiles(inputs: string[]): string[] {
  const files: string[] = [];
  const walk = (p: string) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const name of fs.readdirSync(p).sort()) walk(path.join(p, name));
    else if (/\.csv$/i.test(p)) files.push(p);
  };
  inputs.forEach(walk);
  return files;
}

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const flag = (name: string, fallback: number) => {
    const found = args.find((a) => a.startsWith(`--${name}=`));
    return found ? Number(found.split("=")[1]) : fallback;
  };
  const outPath = args.find((a) => a.startsWith("--out="))?.split("=")[1];
  const inputs = args.filter((a) => !a.startsWith("--"));
  if (!inputs.length) {
    console.error("Uso: backtest <carpeta|archivo.csv> ... [--step-days=7] [--burnin-days=300] [--holdout=0.35] [--out=informe.md]");
    process.exit(1);
  }
  const rows: Row[] = [];
  for (const file of collectFiles(inputs)) {
    const { league, season } = leagueSeasonFromPath(file);
    rows.push(...readRows(fs.readFileSync(file, "utf8"), league, season));
  }
  if (!rows.length) {
    console.error("No se leyó ningún partido (¿columnas Date, HomeTeam, AwayTeam, FTHG, FTAG?).");
    process.exit(1);
  }
  const report = buildReport(rows, {
    stepDays: flag("step-days", 7),
    burninDays: flag("burnin-days", 300),
    holdout: Math.min(0.9, Math.max(0, flag("holdout", 0.35))),
  });
  console.log(report);
  if (outPath) fs.writeFileSync(outPath, report + "\n");
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
