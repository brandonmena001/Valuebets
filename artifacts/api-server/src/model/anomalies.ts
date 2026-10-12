/**
 * Motor PURO de alertas de precio (sin base de datos): errores de cuota y cuotas altas.
 * Reutiliza latestEntries / consensusSamplesOf / consensusOf / classifyQuote / devigPower.
 *
 * Realidad de los datos: las cuotas llegan cada 7-13 h; un error real dura minutos, así que
 * se detectan sobre todo discrepancias persistentes. Nada de esto promete rentabilidad:
 * los umbrales y pesos iniciales NO están calibrados con datos reales.
 */
import { anomalyConfig } from "./config";
import { devigPower, median, sum } from "./math";
import { expectedKeys, type QuoteKind, type SelectionKey, type StatKey } from "./markets";
import {
  consensusOf,
  consensusSamplesOf,
  latestEntries,
  type BlendedSnapshot,
  type Entry,
  type QuoteInput,
} from "./predict";

export type AnomalyConfig = typeof anomalyConfig;
export type AnomalyKind =
  | "high-price"
  | "arbitrage"
  | "inconsistent-line"
  | "swapped-selection"
  | "invalid-odds"
  | "stale-line";
export type Verdict = "tomar" | "vigilar" | "descartar";
export type VoidRisk = "bajo" | "medio" | "alto";

/** Hallazgo antes de puntuar. `deviation` es fracción (0.18 = 18 %); en arbitrage es el margen. */
export type Candidate = {
  kind: AnomalyKind;
  bookmaker: string;
  marketCategory: string;
  marketName: string;
  selection: string;
  selectionKey: string;
  line: number | null;
  playerName: string | null;
  decimalOdds: number;
  consensusProb: number | null;
  fairOdds: number | null;
  referenceBook: string | null;
  deviation: number | null;
  booksUsed: number;
  reasons: string[];
  /** Edad de la cuota (ahora - capturedAt) en minutos. */
  dataAgeMinutes: number;
  /** capturedAt más reciente de las cuotas implicadas (para contar sincronizaciones). */
  capturedAt: Date;
  marketKind: QuoteKind;
  stat: StatKey;
  consensusKey: string;
};

export type Anomaly = Candidate & {
  logKey: string;
  evPct: number | null;
  adjustedEvPct: number | null;
  modelAgrees: boolean | null;
  score: number;
  verdict: Verdict;
  voidRisk: VoidRisk;
  suggestedStakeFraction: number | null;
};

const MIN = 60_000;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const pct = (x: number) => `${(x * 100).toFixed(1).replace(".", ",")} %`;
const num2 = (x: number) => x.toFixed(2);

const ageMinutes = (quote: QuoteInput, now: Date) =>
  Math.max(0, Math.floor((now.getTime() - quote.capturedAt.getTime()) / MIN));

function base(entry: Entry, now: Date): Pick<
  Candidate,
  | "bookmaker" | "marketCategory" | "marketName" | "selection" | "selectionKey" | "line" | "playerName"
  | "decimalOdds" | "dataAgeMinutes" | "capturedAt" | "marketKind" | "stat" | "consensusKey"
> {
  const { quote, c } = entry;
  return {
    bookmaker: quote.bookmaker,
    marketCategory: quote.marketCategory,
    marketName: quote.marketName,
    selection: quote.selection,
    selectionKey: c.selectionKey,
    line: c.line,
    playerName: quote.playerName,
    decimalOdds: quote.decimalOdds,
    dataAgeMinutes: ageMinutes(quote, now),
    capturedAt: quote.capturedAt,
    marketKind: c.kind,
    stat: c.stat,
    consensusKey: c.consensusKey,
  };
}

export function isValidOdds(odds: number, cfg: AnomalyConfig = anomalyConfig): boolean {
  return Number.isFinite(odds) && odds > cfg.invalidMinOdds && odds <= cfg.invalidMaxOdds;
}

const isReference = (bookmaker: string, cfg: AnomalyConfig) =>
  cfg.referenceBooks.some((ref) => bookmaker.toLowerCase().includes(ref));

// ---------- Consenso leave-one-out ----------
export type LooResult = { probs: Map<SelectionKey, number>; books: number; referenceBook: string | null };

/**
 * Consenso de un mercado SIN la casa evaluada (su propio error no contamina la referencia).
 * Mediana de las probabilidades sin margen de las otras casas. Exige `minBooks` casas en
 * total (incluida la evaluada) o `minBooksSharp` si entre las otras hay una casa de referencia aguda.
 */
export function looConsensus(
  entries: Entry[],
  bookmaker: string,
  consensusKey: string,
  kind: QuoteKind,
  cfg: AnomalyConfig = anomalyConfig,
): LooResult | null {
  const others = entries.filter((e) => e.quote.bookmaker !== bookmaker);
  const keys = expectedKeys(kind);
  const refEntries = others.filter((e) => isReference(e.quote.bookmaker, cfg));
  const refSamples = consensusSamplesOf(refEntries).get(consensusKey);
  const hasRef = refSamples ? consensusOf(refSamples, kind, keys[0]!, 1) !== null : false;
  const minOthers = Math.max(1, (hasRef ? cfg.minBooksSharp : cfg.minBooks) - 1);
  const samples = consensusSamplesOf(others).get(consensusKey);
  const probs = new Map<SelectionKey, number>();
  let books = Infinity;
  for (const k of keys) {
    const r = consensusOf(samples, kind, k, minOthers);
    if (!r) return null;
    probs.set(k, r.prob);
    books = Math.min(books, r.books);
  }
  const referenceBook = hasRef ? refEntries.find((e) => e.quote.bookmaker)?.quote.bookmaker ?? null : null;
  return { probs, books, referenceBook };
}

// ---------- Detectores ----------
/** Cuota de una casa frente al consenso leave-one-out de las demás. */
export function detectHighPrice(entries: Entry[], now: Date, cfg: AnomalyConfig = anomalyConfig): Candidate[] {
  const out: Candidate[] = [];
  const cache = new Map<string, LooResult | null>();
  for (const entry of entries) {
    const { quote, c } = entry;
    const cacheKey = `${quote.bookmaker}|${c.consensusKey}`;
    if (!cache.has(cacheKey)) cache.set(cacheKey, looConsensus(entries, quote.bookmaker, c.consensusKey, c.kind, cfg));
    const loo = cache.get(cacheKey);
    const p = loo?.probs.get(c.selectionKey);
    if (!loo || p === undefined || p <= 0) continue;
    const fairOdds = 1 / p;
    const deviation = quote.decimalOdds / fairOdds - 1;
    if (deviation < cfg.highDeviation) continue;
    const probable = deviation >= cfg.errorDeviation;
    out.push({
      kind: "high-price",
      ...base(entry, now),
      consensusProb: p,
      fairOdds,
      referenceBook: loo.referenceBook,
      deviation,
      booksUsed: loo.books,
      reasons: [
        `${quote.bookmaker} paga ${num2(quote.decimalOdds)}; las otras ${loo.books} casas implican ${num2(fairOdds)} (${pct(deviation)} más).`,
        probable
          ? "Desviación de error probable: la casa puede anular la apuesta."
          : "Desviación moderada: puede ser un precio generoso real.",
        ...(loo.referenceBook ? [`Referencia aguda usada: ${loo.referenceBook}.`] : []),
      ],
    });
  }
  return out;
}

/** La mejor cuota de cada resultado, entre casas, suma probabilidad implícita < 1. */
export function detectArbitrage(entries: Entry[], now: Date, cfg: AnomalyConfig = anomalyConfig): Candidate[] {
  const markets = new Map<string, Entry[]>();
  for (const e of entries) {
    const list = markets.get(e.c.consensusKey);
    if (list) list.push(e);
    else markets.set(e.c.consensusKey, [e]);
  }
  const out: Candidate[] = [];
  for (const list of markets.values()) {
    const kind = list[0]!.c.kind;
    const keys = expectedKeys(kind);
    const best = new Map<SelectionKey, Entry>();
    for (const e of list) {
      const cur = best.get(e.c.selectionKey);
      if (!cur || e.quote.decimalOdds > cur.quote.decimalOdds) best.set(e.c.selectionKey, e);
    }
    if (!keys.every((k) => best.has(k))) continue;
    const legs = keys.map((k) => best.get(k)!);
    const total = sum(legs.map((l) => 1 / l.quote.decimalOdds));
    const margin = 1 / total - 1;
    if (total >= 1 || margin < cfg.arbMinMargin) continue;
    const legBooks = new Set(legs.map((l) => l.quote.bookmaker));
    if (legBooks.size < 2) continue; // una sola casa con suma < 1 es cuota inválida, no arbitraje
    const first = legs[0]!;
    out.push({
      kind: "arbitrage",
      ...base(first, now),
      bookmaker: "varias casas",
      selection: "Todas las selecciones",
      selectionKey: "all",
      decimalOdds: 1 / total,
      consensusProb: null,
      fairOdds: null,
      referenceBook: null,
      deviation: margin,
      booksUsed: new Set(list.map((e) => e.quote.bookmaker)).size,
      dataAgeMinutes: Math.max(...legs.map((l) => ageMinutes(l.quote, now))),
      capturedAt: new Date(Math.max(...legs.map((l) => l.quote.capturedAt.getTime()))),
      reasons: [
        `Margen de arbitraje ${pct(margin)}: la suma de probabilidades implícitas de las mejores cuotas es ${total.toFixed(3)}.`,
        ...legs.map((l) => `${l.quote.selection} a ${num2(l.quote.decimalOdds)} en ${l.quote.bookmaker}.`),
        "Las casas pueden anular errores palpables y limitar cuentas.",
      ],
    });
  }
  return out;
}

type BookMarket = { bookmaker: string; kind: QuoteKind; stat: StatKey; consensusKey: string; line: number | null; fair: Map<SelectionKey, number>; entries: Map<SelectionKey, Entry> };

/** Probabilidades sin margen por casa y mercado completo (misma lógica de devig que el consenso). */
function bookMarkets(entries: Entry[]): BookMarket[] {
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = `${e.quote.bookmaker}|${e.c.marketKey}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  const out: BookMarket[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const keys = expectedKeys(first.c.kind);
    const byKey = new Map(group.map((e) => [e.c.selectionKey, e]));
    if (!keys.every((k) => byKey.has(k))) continue;
    const fair = devigPower(keys.map((k) => byKey.get(k)!.quote.decimalOdds));
    if (!fair) continue;
    out.push({
      bookmaker: first.quote.bookmaker,
      kind: first.c.kind,
      stat: first.c.stat,
      consensusKey: first.c.consensusKey,
      line: first.c.line,
      fair: new Map(keys.map((k, i) => [k, fair[i]!])),
      entries: byKey,
    });
  }
  return out;
}

/** Incoherencias dentro de una casa: totales no monótonos, hándicaps no monótonos, BTTS imposible. */
export function detectInconsistentLines(entries: Entry[], now: Date, cfg: AnomalyConfig = anomalyConfig): Candidate[] {
  const out: Candidate[] = [];
  const tol = cfg.lineTolerance;
  const byBook = new Map<string, BookMarket[]>();
  for (const m of bookMarkets(entries)) {
    const list = byBook.get(m.bookmaker);
    if (list) list.push(m);
    else byBook.set(m.bookmaker, [m]);
  }
  for (const [book, markets] of byBook) {
    // Totales (no jugadores): P(más de L) debe bajar al subir L. Hándicap: P(local) debe subir con su línea.
    const series: Array<{ label: string; items: BookMarket[]; key: SelectionKey; direction: 1 | -1 }> = [];
    for (const stat of ["goals", "corners", "cards", "sot"] as StatKey[]) {
      series.push({
        label: `total ${stat}`,
        items: markets.filter((m) => m.kind === "total" && m.stat === stat && !m.consensusKey.startsWith("player")),
        key: "over",
        direction: -1,
      });
    }
    series.push({ label: "hándicap", items: markets.filter((m) => m.kind === "handicap"), key: "home", direction: 1 });
    for (const s of series) {
      const items = s.items.filter((m) => m.line != null).sort((a, b) => a.line! - b.line!);
      for (let i = 1; i < items.length; i += 1) {
        const prev = items[i - 1]!;
        const cur = items[i]!;
        // Totales (direction -1): la probabilidad debe BAJAR al subir la línea; hándicap (1): debe SUBIR.
        // delta >= 0 es lo coherente; una caída mayor que la tolerancia es incoherencia.
        const delta = (cur.fair.get(s.key)! - prev.fair.get(s.key)!) * s.direction;
        if (delta >= -tol) continue;
        const entry = cur.entries.get(s.key)!;
        out.push({
          kind: "inconsistent-line",
          ...base(entry, now),
          consensusProb: null,
          fairOdds: null,
          referenceBook: null,
          deviation: null,
          booksUsed: new Set(entries.filter((e) => e.c.consensusKey === cur.consensusKey).map((e) => e.quote.bookmaker)).size,
          reasons: [
            `${book}: líneas incoherentes en ${s.label} (${prev.line} → ${cur.line}); la probabilidad se mueve en sentido contrario al lógico (${pct(prev.fair.get(s.key)!)} → ${pct(cur.fair.get(s.key)!)}).`,
          ],
        });
      }
    }
    // Ambos anotan sí no puede ser más probable que "más de 1.5 goles".
    const btts = markets.find((m) => m.kind === "btts");
    const over15 = markets.find((m) => m.kind === "total" && m.stat === "goals" && m.line === 1.5 && !m.consensusKey.startsWith("player"));
    if (btts && over15 && btts.fair.get("yes")! > over15.fair.get("over")! + tol) {
      out.push({
        kind: "inconsistent-line",
        ...base(btts.entries.get("yes")!, now),
        consensusProb: null,
        fairOdds: null,
        referenceBook: null,
        deviation: null,
        booksUsed: new Set(entries.filter((e) => e.c.consensusKey === "btts").map((e) => e.quote.bookmaker)).size,
        reasons: [
          `${book}: «ambos anotan» (${pct(btts.fair.get("yes")!)}) es más probable que «más de 1.5 goles» (${pct(over15.fair.get("over")!)}), algo imposible.`,
        ],
      });
    }
  }
  return out;
}

/** Local y visitante intercambiados frente al consenso (resultado 1X2 y hándicap). */
export function detectSwapped(entries: Entry[], now: Date, cfg: AnomalyConfig = anomalyConfig): Candidate[] {
  const out: Candidate[] = [];
  for (const m of bookMarkets(entries)) {
    if (m.kind !== "result" && m.kind !== "handicap") continue;
    const loo = looConsensus(entries, m.bookmaker, m.consensusKey, m.kind, cfg);
    if (!loo) continue;
    const bh = m.fair.get("home")!;
    const ba = m.fair.get("away")!;
    const ch = loo.probs.get("home")!;
    const ca = loo.probs.get("away")!;
    const normal = Math.abs(bh - ch) + Math.abs(ba - ca);
    const swapped = Math.abs(bh - ca) + Math.abs(ba - ch);
    if (normal < cfg.swapMinDistance || swapped > cfg.swapRatio * normal) continue;
    out.push({
      kind: "swapped-selection",
      ...base(m.entries.get("home")!, now),
      consensusProb: ch,
      fairOdds: 1 / ch,
      referenceBook: loo.referenceBook,
      deviation: null,
      booksUsed: loo.books,
      reasons: [
        `${m.bookmaker} da al local ${pct(bh)} y al visitante ${pct(ba)}; el consenso (${loo.books} casas) da ${pct(ch)} y ${pct(ca)}: parecen intercambiados.`,
      ],
    });
  }
  return out;
}

/** Cuotas ≤ 1.01 o > 500, o suma de implícitas de una casa < 0.97 en un mercado completo. */
export function detectInvalid(entries: Entry[], now: Date, cfg: AnomalyConfig = anomalyConfig): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const countBooks = (consensusKey: string) =>
    new Set(entries.filter((e) => e.c.consensusKey === consensusKey).map((e) => e.quote.bookmaker)).size;
  for (const e of entries) {
    if (isValidOdds(e.quote.decimalOdds, cfg)) continue;
    const key = `${e.quote.bookmaker}|${e.c.marketKey}|${e.c.selectionKey}`;
    seen.add(`${e.quote.bookmaker}|${e.c.marketKey}`);
    out.push({
      kind: "invalid-odds",
      ...base(e, now),
      consensusProb: null,
      fairOdds: null,
      referenceBook: null,
      deviation: null,
      booksUsed: countBooks(e.c.consensusKey),
      reasons: [`${e.quote.bookmaker} publica una cuota de ${num2(e.quote.decimalOdds)} (${key.split("|")[2]}), fuera del rango válido.`],
    });
  }
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = `${e.quote.bookmaker}|${e.c.marketKey}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  for (const [key, group] of groups) {
    if (seen.has(key)) continue;
    const keys = expectedKeys(group[0]!.c.kind);
    const byKey = new Map(group.map((e) => [e.c.selectionKey, e]));
    if (!keys.every((k) => byKey.has(k))) continue;
    const total = sum(keys.map((k) => 1 / byKey.get(k)!.quote.decimalOdds));
    if (total >= cfg.invalidMinImpliedSum) continue;
    const top = keys.map((k) => byKey.get(k)!).sort((a, b) => b.quote.decimalOdds - a.quote.decimalOdds)[0]!;
    out.push({
      kind: "invalid-odds",
      ...base(top, now),
      consensusProb: null,
      fairOdds: null,
      referenceBook: null,
      deviation: null,
      booksUsed: countBooks(top.c.consensusKey),
      reasons: [`${top.quote.bookmaker}: las probabilidades implícitas del mercado completo suman ${total.toFixed(3)} (menos de ${cfg.invalidMinImpliedSum}); la casa no cobra margen, algo no cuadra.`],
    });
  }
  return out;
}

/** source_updated_at de una casa muy anterior al de las demás en el mismo mercado. Se marca, no se recomienda. */
export function detectStale(entries: Entry[], now: Date, cfg: AnomalyConfig = anomalyConfig): Candidate[] {
  const out: Candidate[] = [];
  const markets = new Map<string, Map<string, Entry>>(); // consensusKey -> casa -> entrada con source_updated_at más reciente
  for (const e of entries) {
    if (!e.quote.sourceUpdatedAt) continue;
    const byBook = markets.get(e.c.consensusKey) ?? new Map<string, Entry>();
    const cur = byBook.get(e.quote.bookmaker);
    if (!cur || e.quote.sourceUpdatedAt > cur.quote.sourceUpdatedAt!) byBook.set(e.quote.bookmaker, e);
    markets.set(e.c.consensusKey, byBook);
  }
  for (const byBook of markets.values()) {
    for (const [book, entry] of byBook) {
      const others = [...byBook.entries()].filter(([b]) => b !== book).map(([, e]) => e.quote.sourceUpdatedAt!.getTime());
      if (others.length < cfg.staleMinOthers) continue;
      const gapMin = (median(others) - entry.quote.sourceUpdatedAt!.getTime()) / MIN;
      if (gapMin < cfg.staleGapMinutes) continue;
      out.push({
        kind: "stale-line",
        ...base(entry, now),
        consensusProb: null,
        fairOdds: null,
        referenceBook: null,
        deviation: null,
        booksUsed: byBook.size,
        reasons: [`${book} actualizó este mercado hace ${Math.round(gapMin / 60)} h más que la mediana de las otras casas: línea probablemente vieja. Solo se marca.`],
      });
    }
  }
  return out;
}

// ---------- Riesgo, puntaje y veredicto ----------
const STRUCTURAL: AnomalyKind[] = ["arbitrage", "inconsistent-line", "swapped-selection", "invalid-odds"];

export function voidRiskOf(kind: AnomalyKind, deviation: number | null, cfg: AnomalyConfig = anomalyConfig): VoidRisk {
  if (kind === "swapped-selection" || kind === "inconsistent-line" || kind === "invalid-odds") return "alto";
  const d = deviation ?? 0;
  if (d > cfg.voidHighDeviation) return "alto";
  if (d >= cfg.voidMediumDeviation) return "medio";
  return "bajo";
}

export function voidProbability(risk: VoidRisk, cfg: AnomalyConfig = anomalyConfig): number {
  return risk === "alto" ? cfg.voidProbHigh : risk === "medio" ? cfg.voidProbMedium : cfg.voidProbLow;
}

export function freshness(ageMin: number, cfg: AnomalyConfig = anomalyConfig): number {
  if (ageMin <= cfg.freshFullMinutes) return 1;
  if (ageMin >= cfg.freshZeroMinutes) return 0;
  return (cfg.freshZeroMinutes - ageMin) / (cfg.freshZeroMinutes - cfg.freshFullMinutes);
}

function liquidity(c: Pick<Candidate, "marketKind" | "stat" | "playerName">, cfg: AnomalyConfig): number {
  if (c.playerName || c.marketKind === "player") return cfg.liqProps;
  if (c.marketKind === "btts" || c.stat === "corners" || c.stat === "cards") return cfg.liqSecondary;
  if (c.stat === "sot") return cfg.liqSecondary;
  return cfg.liqCore;
}

/** Puntaje entero de 0 a 100. `modelAgrees`: true/false, o null si no hay modelo para ese precio. */
export function scoreAnomaly(c: Candidate, modelAgrees: boolean | null, cfg: AnomalyConfig = anomalyConfig): number {
  const dev =
    c.kind === "high-price"
      ? clamp01((c.deviation ?? 0) / cfg.devFullHighPrice)
      : c.kind === "arbitrage"
        ? clamp01((c.deviation ?? 0) / cfg.devFullArbitrage)
        : c.kind === "stale-line"
          ? 0
          : 1;
  const conf = clamp01(c.booksUsed / cfg.confFullBooks);
  const agree = modelAgrees === null ? 0.5 : modelAgrees ? 1 : 0;
  const fresh = freshness(c.dataAgeMinutes, cfg);
  const liq = liquidity(c, cfg);
  const bonus = STRUCTURAL.includes(c.kind) ? cfg.bonusStructural : c.kind === "high-price" ? cfg.bonusHighPrice : 0;
  const raw = cfg.wDev * dev + cfg.wConf * conf + cfg.wAgree * agree + cfg.wFresh * fresh + cfg.wLiq * liq + cfg.wBonus * bonus;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

export function verdictOf(
  a: { score: number; voidRisk: VoidRisk; dataAgeMinutes: number; adjustedEvPct: number | null; kind: AnomalyKind },
  cfg: AnomalyConfig = anomalyConfig,
): Verdict {
  if (a.score < cfg.discardMaxScore || a.dataAgeMinutes > cfg.discardAgeMinutes || a.kind === "stale-line" || a.kind === "invalid-odds") {
    return "descartar";
  }
  if (
    a.score >= cfg.takeMinScore &&
    a.voidRisk !== "alto" &&
    a.dataAgeMinutes <= cfg.takeMaxAgeMinutes &&
    (a.adjustedEvPct ?? -Infinity) >= cfg.takeMinAdjustedEvPct &&
    (a.kind === "high-price" || a.kind === "arbitrage")
  ) {
    return "tomar";
  }
  return "vigilar";
}

/** Kelly fraccional con tope; en arbitraje (sin probabilidad) se usa el tope como banca total entre las patas. */
export function suggestedStake(c: Candidate, voidRisk: VoidRisk, verdict: Verdict, cfg: AnomalyConfig = anomalyConfig): number | null {
  if (verdict !== "tomar") return null;
  const cap = voidRisk === "alto" ? Math.min(cfg.maxStakeFraction, cfg.maxStakeFractionHighVoid) : cfg.maxStakeFraction;
  if (c.kind === "arbitrage" || c.consensusProb === null) return cap;
  const edge = c.consensusProb * c.decimalOdds - 1;
  if (edge <= 0 || c.decimalOdds <= 1) return 0;
  const kelly = (edge / (c.decimalOdds - 1)) * cfg.kellyFraction * (1 - voidProbability(voidRisk, cfg));
  return Math.min(cap, Math.max(0, kelly));
}

/** ¿Ve valor el modelo (probabilidad mezclada) a ese precio? null si no hay modelo para ese mercado. */
export function modelProbabilityFor(blended: BlendedSnapshot | null, c: Pick<Candidate, "marketKind" | "stat" | "selectionKey" | "line">): number | null {
  if (!blended) return null;
  if (c.marketKind === "result" && blended.result) {
    return blended.result.probs[c.selectionKey as "home" | "draw" | "away"] ?? null;
  }
  if (c.marketKind === "btts" && blended.btts) return c.selectionKey === "yes" ? blended.btts.yes : 1 - blended.btts.yes;
  if (c.marketKind === "total" && c.stat === "goals" && c.line != null) {
    const row = blended.goalLines.find((g) => g.line === c.line);
    if (row) return c.selectionKey === "over" ? row.over : 1 - row.over;
  }
  return null;
}

export function logKeyOf(matchId: number, c: Candidate): string {
  return [matchId, c.bookmaker, c.consensusKey, c.selectionKey, c.line ?? "", c.playerName ?? "", c.kind].join("|");
}

/** Completa un hallazgo: EV, riesgo de anulación, puntaje, veredicto y apuesta sugerida. */
export function finalizeAnomaly(
  matchId: number,
  c: Candidate,
  modelProb: number | null,
  cfg: AnomalyConfig = anomalyConfig,
): Anomaly {
  const voidRisk = voidRiskOf(c.kind, c.deviation, cfg);
  const modelAgrees = c.kind === "arbitrage" || modelProb === null ? null : modelProb * c.decimalOdds >= 1;
  const evPct =
    c.kind === "high-price" && c.consensusProb !== null
      ? (c.consensusProb * c.decimalOdds - 1) * 100
      : c.kind === "arbitrage" && c.deviation !== null
        ? c.deviation * 100
        : null;
  const adjustedEvPct = evPct === null ? null : evPct * (1 - voidProbability(voidRisk, cfg));
  const score = scoreAnomaly(c, modelAgrees, cfg);
  const verdict = verdictOf({ score, voidRisk, dataAgeMinutes: c.dataAgeMinutes, adjustedEvPct, kind: c.kind }, cfg);
  return {
    ...c,
    logKey: logKeyOf(matchId, c),
    evPct,
    adjustedEvPct,
    modelAgrees,
    score,
    verdict,
    voidRisk,
    suggestedStakeFraction: suggestedStake(c, voidRisk, verdict, cfg),
  };
}

/** Detecta todo en un partido. `modelProb` se llama solo para los hallazgos (suele ser perezoso/caro). */
export function analyzeMatch(input: {
  matchId: number;
  match: { homeTeam: string; awayTeam: string };
  quotes: QuoteInput[];
  now: Date;
  modelProb?: (c: Candidate) => number | null;
  cfg?: AnomalyConfig;
}): Anomaly[] {
  const cfg = input.cfg ?? anomalyConfig;
  const all = latestEntries(input.quotes, input.match);
  const valid = all.filter((e) => isValidOdds(e.quote.decimalOdds, cfg));
  const candidates = [
    ...detectInvalid(all, input.now, cfg),
    ...detectHighPrice(valid, input.now, cfg),
    ...detectArbitrage(valid, input.now, cfg),
    ...detectInconsistentLines(valid, input.now, cfg),
    ...detectSwapped(valid, input.now, cfg),
    ...detectStale(valid, input.now, cfg),
  ];
  return candidates
    .map((c) => finalizeAnomaly(input.matchId, c, input.modelProb ? input.modelProb(c) : null, cfg))
    .sort((a, b) => b.score - a.score);
}
