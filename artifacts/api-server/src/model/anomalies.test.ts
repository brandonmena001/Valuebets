import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeMatch, finalizeAnomaly, freshness, looConsensus, modelProbabilityFor, scoreAnomaly, verdictOf,
  voidProbability, voidRiskOf, type Candidate,
} from "./anomalies";
import { latestEntries, type QuoteInput } from "./predict";

const NOW = new Date("2026-10-11T12:00:00Z");
const MATCH = { homeTeam: "Team A", awayTeam: "Team B" };
const MATCH_ID = 7;

// Generador pseudoaleatorio determinista (mulberry32).
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let nextId = 1;
type Opts = { ageMin?: number; sourceAgeMin?: number | null };
function q(book: string, name: string, category: string, selection: string, odds: number, line: number | null, o: Opts = {}, matchId = MATCH_ID): QuoteInput {
  const captured = new Date(NOW.getTime() - (o.ageMin ?? 30) * 60_000);
  return {
    id: nextId++, matchId, bookmaker: book, upstreamMarketId: name, marketCategory: category, marketName: name, selection,
    playerName: null, line, decimalOdds: odds, capturedAt: captured,
    sourceUpdatedAt: o.sourceAgeMin == null ? null : new Date(NOW.getTime() - o.sourceAgeMin * 60_000),
  };
}
/** 1X2 de una casa con margen proporcional. */
function result(book: string, p: [number, number, number], margin: number, mult: [number, number, number] = [1, 1, 1], o: Opts = {}): QuoteInput[] {
  return (["1", "X", "2"] as const).map((sel, i) =>
    q(book, "Full Time Result", "match-result", sel, (1 / (p[i]! * (1 + margin))) * mult[i]!, null, o));
}
/** Total de goles a dos vías con margen. */
function total(book: string, line: number, pOver: number, margin: number, o: Opts = {}): QuoteInput[] {
  return [
    q(book, "Total Goals", "goals", "Over", 1 / (pOver * (1 + margin)), line, o),
    q(book, "Total Goals", "goals", "Under", 1 / ((1 - pOver) * (1 + margin)), line, o),
  ];
}
const BOOKS = ["b1", "b2", "b3", "b4", "b5", "b6"];
const P: [number, number, number] = [0.45, 0.27, 0.28];
const analyze = (quotes: QuoteInput[], modelProb?: (c: Candidate) => number | null) =>
  analyzeMatch({ matchId: MATCH_ID, match: MATCH, quotes, now: NOW, modelProb });

describe("(a) cuota multiplicada por 1.4 en una casa", () => {
  it("se detecta como high-price con riesgo de anulación alto", () => {
    const quotes = BOOKS.flatMap((b) => result(b, P, 0.05, b === "b3" ? [1.4, 1, 1] : [1, 1, 1]));
    const hp = analyze(quotes).filter((a) => a.kind === "high-price");
    assert.equal(hp.length, 1);
    const a = hp[0]!;
    assert.equal(a.bookmaker, "b3");
    assert.equal(a.selectionKey, "home");
    assert.ok(a.deviation! > 0.25 && a.deviation! < 0.4, `desviación ${a.deviation}`);
    assert.equal(a.voidRisk, "alto");
    assert.equal(a.booksUsed, 5); // consenso leave-one-out: las otras 5 casas
    assert.notEqual(a.verdict, "tomar");
    assert.ok(a.suggestedStakeFraction === null);
    assert.ok(a.reasons.length >= 2);
  });

  it("el consenso excluye a la casa evaluada (su error no contamina la referencia)", () => {
    const quotes = BOOKS.flatMap((b) => result(b, P, 0.05, b === "b3" ? [1.4, 1, 1] : [1, 1, 1]));
    const entries = latestEntries(quotes, MATCH);
    const loo = looConsensus(entries, "b3", "result", "result")!;
    const honest = looConsensus(entries, "b1", "result", "result")!;
    assert.ok(Math.abs(loo.probs.get("home")! - 0.45) < 0.01, "sin b3, el consenso local ≈ 0.45");
    // Con cuota alta, b3 implica MENOS probabilidad local: si estuviera dentro empujaría el consenso a la baja.
    assert.ok(honest.probs.get("home")! <= loo.probs.get("home")!, "con b3 dentro, el consenso no puede subir");
    assert.equal(loo.books, 5);
  });
});

describe("(b) surebet inyectada", () => {
  it("se detecta con su margen y patas", () => {
    const quotes = [
      ...["b1", "b2", "b3", "b4"].flatMap((b) => result(b, [0.4, 0.3, 0.3], 0.05)),
      ...result("b5", [0.4, 0.3, 0.3], 0.05, [1.22, 1, 1]), // local 2.90
    ];
    const arb = analyze(quotes).filter((a) => a.kind === "arbitrage");
    assert.equal(arb.length, 1);
    const a = arb[0]!;
    assert.ok(a.deviation! > 0.02 && a.deviation! < 0.03, `margen ${a.deviation}`);
    assert.equal(a.bookmaker, "varias casas");
    assert.equal(a.reasons.length, 5); // resumen + 3 patas + aviso de anulación
    assert.ok(a.evPct! > 2);
  });

  it("no hay arbitraje con una sola casa aunque la suma sea menor que 1", () => {
    const quotes = [...result("b1", [0.4, 0.3, 0.3], -0.05), ...BOOKS.slice(1, 4).flatMap((b) => result(b, [0.4, 0.3, 0.3], -0.05, [0.5, 0.5, 0.5]))];
    assert.equal(analyze(quotes).filter((a) => a.kind === "arbitrage").length, 0);
  });
});

describe("(c) línea incoherente", () => {
  it("p(más de 3.5) mayor que p(más de 2.5) en una casa se detecta", () => {
    const quotes = BOOKS.flatMap((b) => [
      ...total(b, 2.5, 0.52, 0.05),
      ...total(b, 3.5, b === "b2" ? 0.6 : 0.28, 0.05),
    ]);
    const bad = analyze(quotes).filter((a) => a.kind === "inconsistent-line");
    assert.equal(bad.length, 1);
    assert.equal(bad[0]!.bookmaker, "b2");
    assert.equal(bad[0]!.line, 3.5);
    assert.equal(bad[0]!.voidRisk, "alto");
    assert.notEqual(bad[0]!.verdict, "tomar");
  });

  it("ambos anotan más probable que más de 1.5 goles es imposible", () => {
    const quotes = BOOKS.flatMap((b) => [
      ...total(b, 1.5, 0.75, 0.05),
      q(b, "Both Teams To Score", "goals", "Yes", 1 / ((b === "b4" ? 0.9 : 0.55) * 1.05), null),
      q(b, "Both Teams To Score", "goals", "No", 1 / ((b === "b4" ? 0.1 : 0.45) * 1.05), null),
    ]);
    const bad = analyze(quotes).filter((a) => a.kind === "inconsistent-line");
    assert.equal(bad.length, 1);
    assert.equal(bad[0]!.bookmaker, "b4");
  });
});

describe("(d) ruido normal de ±3 % en 200 partidos", () => {
  it("la tasa de falsas alertas es menor al 1 %", (t) => {
    const rand = rng(12345);
    let quotesCount = 0;
    let alerts = 0;
    const byKind: Record<string, number> = {};
    for (let m = 0; m < 200; m += 1) {
      const a = 0.2 + rand() * 0.4; // local 0.20-0.60
      const d = 0.2 + rand() * 0.1; // empate 0.20-0.30 (el visitante queda >= 0.10)
      const p: [number, number, number] = [a, d, 1 - a - d];
      const lines = [[1.5, 0.78], [2.5, 0.35 + rand() * 0.3], [3.5, 0.15 + rand() * 0.1]] as const;
      const quotes: QuoteInput[] = [];
      for (const b of BOOKS) {
        const margin = 0.04 + rand() * 0.03;
        const noise = () => 1 + (rand() * 2 - 1) * 0.03;
        const age = 20 + rand() * 60;
        const o: Opts = { ageMin: age, sourceAgeMin: age + rand() * 30 };
        quotes.push(...result(b, p, margin, [noise(), noise(), noise()], o));
        for (const [line, po] of lines) {
          const pl = Math.min(po, 0.9);
          const ov = q(b, "Total Goals", "goals", "Over", (1 / (pl * (1 + margin))) * noise(), line, o);
          const un = q(b, "Total Goals", "goals", "Under", (1 / ((1 - pl) * (1 + margin))) * noise(), line, o);
          quotes.push(ov, un);
        }
      }
      // Las probabilidades de las líneas deben ser monótonas por construcción: 2.5 < 1.5 y 3.5 < 2.5
      quotesCount += quotes.length;
      const found = analyze(quotes.map((x) => ({ ...x, matchId: MATCH_ID })));
      alerts += found.length;
      for (const f of found) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
      assert.equal(found.filter((x) => x.verdict === "tomar").length, 0);
    }
    const rate = alerts / quotesCount;
    t.diagnostic(`falsas alertas: ${alerts} de ${quotesCount} cuotas (${(rate * 100).toFixed(3)} %) ${JSON.stringify(byKind)}`);
    assert.ok(rate < 0.01, `falsas alertas ${(rate * 100).toFixed(3)} % (${alerts}/${quotesCount}) ${JSON.stringify(byKind)}`);
  });
});

describe("(e) cuota vieja", () => {
  it("una cuota con 10 h se marca descartar y nunca tomar", () => {
    const quotes = BOOKS.flatMap((b) => result(b, P, 0.05, b === "b3" ? [1.2, 1, 1] : [1, 1, 1], { ageMin: 600 }));
    const found = analyze(quotes);
    assert.ok(found.length > 0);
    for (const a of found) {
      assert.equal(a.verdict, "descartar");
      assert.equal(a.suggestedStakeFraction, null);
    }
  });

  it("con 4-8 h es vigilar (no tomar) aunque el precio sea bueno", () => {
    const quotes = BOOKS.flatMap((b) => result(b, P, 0.05, b === "b3" ? [1.2, 1, 1] : [1, 1, 1], { ageMin: 300 }));
    const hp = analyze(quotes, (c) => c.consensusProb).filter((a) => a.kind === "high-price");
    assert.equal(hp.length, 1);
    assert.equal(hp[0]!.verdict, "vigilar");
  });

  it("una casa con source_updated_at muy anterior se marca stale-line y se descarta", () => {
    const quotes = BOOKS.flatMap((b) => result(b, P, 0.05, [1, 1, 1], { ageMin: 30, sourceAgeMin: b === "b1" ? 900 : 60 }));
    const stale = analyze(quotes).filter((a) => a.kind === "stale-line");
    assert.equal(stale.length, 1);
    assert.equal(stale[0]!.bookmaker, "b1");
    assert.equal(stale[0]!.verdict, "descartar");
    assert.equal(stale[0]!.suggestedStakeFraction, null);
  });
});

describe("(f) pocas casas", () => {
  it("con menos de 4 casas no se genera high-price", () => {
    const three = ["b1", "b2", "b3"].flatMap((b) => result(b, P, 0.05, b === "b3" ? [1.4, 1, 1] : [1, 1, 1]));
    assert.equal(analyze(three).filter((a) => a.kind === "high-price").length, 0);
    const four = ["b1", "b2", "b3", "b4"].flatMap((b) => result(b, P, 0.05, b === "b3" ? [1.4, 1, 1] : [1, 1, 1]));
    assert.equal(analyze(four).filter((a) => a.kind === "high-price").length, 1);
  });

  it("con una casa de referencia aguda bastan 2", () => {
    const two = [...result("pinnacle", P, 0.02), ...result("b2", P, 0.05, [1.3, 1, 1])];
    const hp = analyze(two).filter((a) => a.kind === "high-price");
    assert.equal(hp.length, 1);
    assert.equal(hp[0]!.bookmaker, "b2");
    assert.equal(hp[0]!.referenceBook, "pinnacle");
    // sin referencia aguda, las mismas 2 casas no generan nada
    const noRef = [...result("b1", P, 0.02), ...result("b2", P, 0.05, [1.3, 1, 1])];
    assert.equal(analyze(noRef).filter((a) => a.kind === "high-price").length, 0);
  });
});

describe("otras señales", () => {
  it("local y visitante intercambiados frente al consenso", () => {
    const p: [number, number, number] = [0.6, 0.22, 0.18];
    const quotes = BOOKS.flatMap((b) => result(b, b === "b5" ? [0.18, 0.22, 0.6] : p, 0.05));
    const sw = analyze(quotes).filter((a) => a.kind === "swapped-selection");
    assert.equal(sw.length, 1);
    assert.equal(sw[0]!.bookmaker, "b5");
    assert.equal(sw[0]!.voidRisk, "alto");
    assert.notEqual(sw[0]!.verdict, "tomar");
  });

  it("cuota ≤ 1.01 o suma de implícitas < 0.97 es invalid-odds y se descarta", () => {
    const bad = analyze([...BOOKS.flatMap((b) => result(b, P, 0.05)), q("b1", "Total Goals", "goals", "Over", 1.0, 2.5, {})]);
    const inv = bad.filter((a) => a.kind === "invalid-odds");
    assert.equal(inv.length, 1);
    assert.equal(inv[0]!.verdict, "descartar");
    // La cuota inválida no se usa como consenso para acusar a las demás casas.
    assert.equal(bad.filter((a) => a.kind === "high-price").length, 0);
    const cheap = [...BOOKS.slice(1).flatMap((b) => result(b, P, 0.05)), ...result("b1", P, -0.1)];
    const inv2 = analyze(cheap).filter((a) => a.kind === "invalid-odds");
    assert.equal(inv2.length, 1);
    assert.equal(inv2[0]!.bookmaker, "b1");
  });

  it("una oportunidad buena y fresca con el modelo de acuerdo es tomar, con apuesta acotada", () => {
    const quotes = BOOKS.flatMap((b) => result(b, P, 0.05, b === "b3" ? [1.18, 1, 1] : [1, 1, 1], { ageMin: 30 }));
    const sinModelo = analyze(quotes).find((a) => a.kind === "high-price")!;
    assert.equal(sinModelo.modelAgrees, null);
    const conModelo = analyze(quotes, (c) => c.consensusProb).find((a) => a.kind === "high-price")!;
    assert.equal(conModelo.modelAgrees, true);
    assert.equal(conModelo.voidRisk, "bajo");
    assert.ok(conModelo.score >= 70, `score ${conModelo.score}`);
    assert.equal(conModelo.verdict, "tomar");
    assert.ok(conModelo.suggestedStakeFraction! > 0 && conModelo.suggestedStakeFraction! <= 0.02);
    assert.ok(Math.abs(conModelo.adjustedEvPct! - conModelo.evPct! * 0.98) < 1e-9);
  });

  it("si el modelo discrepa baja el puntaje", () => {
    const quotes = BOOKS.flatMap((b) => result(b, P, 0.05, b === "b3" ? [1.18, 1, 1] : [1, 1, 1]));
    const disagree = analyze(quotes, () => 0.2).find((a) => a.kind === "high-price")!;
    assert.equal(disagree.modelAgrees, false);
    assert.notEqual(disagree.verdict, "tomar");
  });
});

describe("puntaje, riesgo y veredicto", () => {
  const cand = (over: Partial<Candidate>): Candidate => ({
    kind: "high-price", bookmaker: "b", marketCategory: "match-result", marketName: "R", selection: "1", selectionKey: "home",
    line: null, playerName: null, decimalOdds: 2.5, consensusProb: 0.45, fairOdds: 2.2, referenceBook: null, deviation: 0.2,
    booksUsed: 8, reasons: [], dataAgeMinutes: 0, capturedAt: NOW, marketKind: "result", stat: "goals", consensusKey: "result", ...over,
  });

  it("frescura baja linealmente de 180 a 540 minutos", () => {
    assert.equal(freshness(0), 1);
    assert.equal(freshness(180), 1);
    assert.equal(freshness(360), 0.5);
    assert.equal(freshness(540), 0);
    assert.equal(freshness(900), 0);
  });

  it("puntaje máximo y mínimo dentro de 0-100 y entero", () => {
    const best = scoreAnomaly(cand({ deviation: 0.5 }), true);
    assert.ok(best <= 100 && Number.isInteger(best));
    // 35 + 20 + 15 + 15 + 10 + 2.5 = 97.5 -> 98
    assert.equal(best, 98);
    const worst = scoreAnomaly(cand({ kind: "stale-line", deviation: null, booksUsed: 0, dataAgeMinutes: 900, marketKind: "player", playerName: "X" }), false);
    assert.ok(worst >= 0 && worst <= 5);
  });

  it("riesgo de anulación por desviación y por tipo", () => {
    assert.equal(voidRiskOf("high-price", 0.1), "bajo");
    assert.equal(voidRiskOf("high-price", 0.15), "medio");
    assert.equal(voidRiskOf("high-price", 0.25), "medio");
    assert.equal(voidRiskOf("high-price", 0.26), "alto");
    for (const k of ["swapped-selection", "inconsistent-line", "invalid-odds"] as const) assert.equal(voidRiskOf(k, 0), "alto");
    assert.equal(voidProbability("bajo"), 0.02);
    assert.equal(voidProbability("medio"), 0.15);
    assert.equal(voidProbability("alto"), 0.5);
  });

  it("reglas del veredicto", () => {
    const ok = { score: 80, voidRisk: "bajo" as const, dataAgeMinutes: 60, adjustedEvPct: 5, kind: "high-price" as const };
    assert.equal(verdictOf(ok), "tomar");
    assert.equal(verdictOf({ ...ok, voidRisk: "alto" }), "vigilar");
    assert.equal(verdictOf({ ...ok, dataAgeMinutes: 181 }), "vigilar");
    assert.equal(verdictOf({ ...ok, adjustedEvPct: 2.9 }), "vigilar");
    assert.equal(verdictOf({ ...ok, kind: "inconsistent-line" }), "vigilar");
    assert.equal(verdictOf({ ...ok, kind: "arbitrage" }), "tomar");
    assert.equal(verdictOf({ ...ok, score: 69 }), "vigilar");
    assert.equal(verdictOf({ ...ok, score: 39 }), "descartar");
    assert.equal(verdictOf({ ...ok, dataAgeMinutes: 541 }), "descartar");
    assert.equal(verdictOf({ ...ok, kind: "stale-line" }), "descartar");
    assert.equal(verdictOf({ ...ok, kind: "invalid-odds" }), "descartar");
  });

  it("la apuesta de una surebet tomable usa el tope; con riesgo alto nunca es tomar", () => {
    const quotes = [
      ...["b1", "b2", "b3", "b4"].flatMap((b) => result(b, [0.4, 0.3, 0.3], 0.05)),
      ...result("b5", [0.4, 0.3, 0.3], 0.05, [1.22, 1, 1]),
    ];
    const arb = analyze(quotes).find((a) => a.kind === "arbitrage")!;
    if (arb.verdict === "tomar") assert.ok(arb.suggestedStakeFraction! <= 0.02);
    const f = finalizeAnomaly(MATCH_ID, cand({ deviation: 0.3 }), null);
    assert.equal(f.voidRisk, "alto");
    assert.notEqual(f.verdict, "tomar");
  });

  it("el modelo mezclado se consulta por mercado (1X2, ambos anotan, líneas de goles)", () => {
    const blended = {
      result: { probs: { home: 0.5, draw: 0.25, away: 0.25 }, market: { home: 0.5, draw: 0.25, away: 0.25 }, modelWeight: 0.2, bookmakers: 5 },
      btts: { yes: 0.6, marketYes: 0.6, modelWeight: 0.2, bookmakers: 5 },
      goalLines: [{ line: 2.5, over: 0.55, marketOver: 0.55, modelWeight: 0.2, bookmakers: 5 }],
    };
    assert.equal(modelProbabilityFor(blended, { marketKind: "result", stat: "goals", selectionKey: "draw", line: null }), 0.25);
    assert.equal(modelProbabilityFor(blended, { marketKind: "btts", stat: "goals", selectionKey: "no", line: null }), 0.4);
    assert.ok(Math.abs(modelProbabilityFor(blended, { marketKind: "total", stat: "goals", selectionKey: "under", line: 2.5 })! - 0.45) < 1e-12);
    assert.equal(modelProbabilityFor(blended, { marketKind: "total", stat: "corners", selectionKey: "over", line: 9.5 }), null);
    assert.equal(modelProbabilityFor(null, { marketKind: "result", stat: "goals", selectionKey: "home", line: null }), null);
  });

  it("la llave de log es estable y distingue kind", () => {
    const quotes = BOOKS.flatMap((b) => result(b, P, 0.05, b === "b3" ? [1.4, 1, 1] : [1, 1, 1]));
    const a1 = analyze(quotes).find((a) => a.kind === "high-price")!;
    const a2 = analyze(quotes.map((x) => ({ ...x, id: x.id + 1000 }))).find((a) => a.kind === "high-price")!;
    assert.equal(a1.logKey, a2.logKey);
    assert.ok(a1.logKey.startsWith(`${MATCH_ID}|b3|result|home||`));
    assert.ok(a1.logKey.endsWith("|high-price"));
  });
});
