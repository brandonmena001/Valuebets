import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { devigPower, negBinPmf, overProbability, poissonPmf, sum } from "./math";
import { resolveName } from "./names";
import { classifyQuote } from "./markets";
import { buildPredictions, type HistoryMatch, type QuoteInput, type UpcomingMatch } from "./predict";
import { settleOutcome } from "./settle";
import { expectedRates, fitRateModel, resultProbs, scoreMatrix, totalCountPmf, type Obs } from "./strength";

function rng(seed: number) {
  let a = seed;
  const uniform = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
  const poisson = (lambda: number) => {
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do { k += 1; p *= uniform(); } while (p > limit);
    return k - 1;
  };
  return { uniform, normal, poisson };
}

const NOW = new Date("2026-10-03T12:00:00Z");
const DAY = 86_400_000;

function league(seed: number, nTeams = 20) {
  const r = rng(seed);
  const names = Array.from({ length: nTeams }, (_, i) => `team ${String.fromCharCode(97 + i)}`);
  const att = names.map(() => Math.exp(0.28 * r.normal()));
  const def = names.map(() => Math.exp(0.22 * r.normal()));
  const mu = 1.15;
  const ha = 1.25;
  const rates = (h: number, a: number) => ({
    lh: mu * ha * att[h]! * def[a]!,
    la: mu * att[a]! * def[h]!,
  });
  const pairs: Array<[number, number]> = [];
  for (let h = 0; h < nTeams; h += 1) for (let a = 0; a < nTeams; a += 1) if (h !== a) pairs.push([h, a]);
  pairs.sort(() => r.uniform() - 0.5);
  const history: HistoryMatch[] = pairs.map(([h, a], i) => {
    const { lh, la } = rates(h, a);
    const noise = () => Math.exp(0.22 * r.normal() - 0.024);
    return {
      id: i + 1, leagueCode: "premier-league", homeTeam: names[h]!, awayTeam: names[a]!,
      kickoff: new Date(NOW.getTime() - (420 - (i * 400) / pairs.length) * DAY),
      homeScore: r.poisson(lh), awayScore: r.poisson(la),
      homeCorners: r.poisson(5.2 * (lh / 1.4) * noise()), awayCorners: r.poisson(4.4 * (la / 1.1) * noise()),
      homeYellowCards: r.poisson(1.8 * noise()), awayYellowCards: r.poisson(2 * noise()),
      homeRedCards: 0, awayRedCards: 0,
      homeShotsOnTarget: r.poisson(4.6 * (lh / 1.4)), awayShotsOnTarget: r.poisson(3.6 * (la / 1.1)),
    };
  });
  return { names, rates, history, r };
}

describe("ajuste de fuerza de equipos", () => {
  it("recupera la fuerza real y supera al modelo ingenuo fuera de muestra", () => {
    const { names, rates, history } = league(7);
    const sorted = [...history].sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());
    const train = sorted.slice(0, 300);
    const test = sorted.slice(300);
    const obs: Obs[] = train.map((m) => ({
      home: m.homeTeam, away: m.awayTeam, hv: m.homeScore!, av: m.awayScore!, w: 1,
    }));
    const model = fitRateModel(obs, 5, { goals: true })!;
    assert.ok(model);
    assert.ok(Math.abs(model.ha - 1.25) < 0.2, `ha=${model.ha}`);

    let ll = 0;
    let llNaive = 0;
    let llTruth = 0;
    const freq = { home: 0, draw: 0, away: 0 };
    for (const m of train) freq[m.homeScore! > m.awayScore! ? "home" : m.homeScore! < m.awayScore! ? "away" : "draw"] += 1 / train.length;
    for (const m of test) {
      const actual = m.homeScore! > m.awayScore! ? "home" : m.homeScore! < m.awayScore! ? "away" : "draw";
      const rt = expectedRates(model, m.homeTeam, m.awayTeam)!;
      ll -= Math.log(resultProbs(scoreMatrix(rt.lh, rt.la, model.rho))[actual]);
      llNaive -= Math.log(freq[actual]);
      const h = names.indexOf(m.homeTeam);
      const a = names.indexOf(m.awayTeam);
      const t = rates(h, a);
      llTruth -= Math.log(resultProbs(scoreMatrix(t.lh, t.la, 0))[actual]);
    }
    assert.ok(ll < llNaive, `modelo ${ll.toFixed(2)} vs ingenuo ${llNaive.toFixed(2)}`);
    // Con ~30 partidos por equipo hay error de estimación inevitable; no debe pasar de ~0.06 nats/partido.
    assert.ok(ll - llTruth < 0.06 * test.length, `brecha vs verdad ${(ll - llTruth).toFixed(2)}`);
  });

  it("el encogimiento evita probabilidades extremas con pocos partidos", () => {
    const obs: Obs[] = [];
    for (let i = 0; i < 12; i += 1) obs.push({ home: "a", away: "b", hv: 4, av: 0, w: 1 }, { home: "c", away: "d", hv: 1, av: 1, w: 1 });
    const model = fitRateModel(obs, 5, { goals: true })!;
    const rates = expectedRates(model, "a", "b")!;
    assert.ok(rates.lh < 4, `lambda local ${rates.lh}`);
    assert.ok(model.att.get("a")! < 3);
  });
});

describe("distribuciones y mercado", () => {
  it("la binomial negativa tiene la media y la varianza pedidas", () => {
    const pmf = negBinPmf(10, 0.1);
    const mean = sum(pmf.map((p, k) => p * k));
    const variance = sum(pmf.map((p, k) => p * (k - mean) ** 2));
    assert.ok(Math.abs(sum(pmf) - 1) < 1e-9);
    assert.ok(Math.abs(mean - 10) < 1e-3);
    assert.ok(Math.abs(variance - 20) < 0.05, `var=${variance}`);
    // Con sobredispersión la cola es más pesada que con Poisson.
    assert.ok(overProbability(pmf, 16.5) > overProbability(poissonPmf(10), 16.5));
  });

  it("el total de dos NB mantiene la media", () => {
    const pmf = totalCountPmf(5.5, 4.5, 0.08);
    assert.ok(Math.abs(sum(pmf.map((p, k) => p * k)) - 10) < 1e-3);
  });

  it("quitar el margen devuelve probabilidades que suman 1", () => {
    const fair = devigPower([2.1, 3.4, 3.6])!;
    assert.ok(Math.abs(sum(fair) - 1) < 1e-9);
    assert.ok(fair[0]! < 1 / 2.1);
    assert.equal(devigPower([1.5, 1.5]), null); // arbitraje / datos incompletos
  });

  it("no mezcla mercados de 1ª parte ni de equipo con el partido completo", () => {
    const match = { homeTeam: "Arsenal", awayTeam: "Chelsea" };
    const base = { playerName: null, line: null, upstreamMarketId: null, selection: "1" };
    assert.ok(classifyQuote({ ...base, marketCategory: "match-result", marketName: "Full Time Result" }, match));
    assert.equal(classifyQuote({ ...base, marketCategory: "match-result", marketName: "1st Half 1X2" }, match), null);
    const total = { ...base, marketCategory: "goals", selection: "Over 2.5", line: 2.5 };
    assert.ok(classifyQuote({ ...total, marketName: "Total Goals Over/Under" }, match));
    assert.equal(classifyQuote({ ...total, marketName: "Arsenal Team Total Goals" }, match), null);
    assert.equal(classifyQuote({ ...total, marketName: "1st Half Total Goals" }, match), null);
    assert.equal(classifyQuote({ ...total, line: 2, marketName: "Total Goals" }, match), null);
  });

  it("resuelve nombres de equipos con alias y rechaza ambigüedades", () => {
    const known = ["manchester city", "manchester united", "tottenham hotspur", "real madrid", "real betis"];
    assert.equal(resolveName("Man City", known), "manchester city");
    assert.equal(resolveName("Manchester United FC", known), "manchester united");
    assert.equal(resolveName("Spurs", known), "tottenham hotspur");
    assert.equal(resolveName("Real", known), null);
    assert.equal(resolveName("Manchester", known), null);
  });
});

describe("liquidación", () => {
  const stats = {
    homeCorners: 6, awayCorners: 5, homeYellowCards: 2, awayYellowCards: 3, homeRedCards: 0, awayRedCards: 1,
    homeShotsOnTarget: 5, awayShotsOnTarget: 3,
  };
  const base = { line: null, playerName: null, homeScore: 2, awayScore: 1, stats, playerShots: null };
  it("liquida 1X2, totales y props", () => {
    assert.equal(settleOutcome({ ...base, marketCategory: "match-result", selectionKey: "home" }), "win");
    assert.equal(settleOutcome({ ...base, marketCategory: "match-result", selectionKey: "draw" }), "loss");
    assert.equal(settleOutcome({ ...base, marketCategory: "goals", selectionKey: "over", line: 2.5 }), "win");
    assert.equal(settleOutcome({ ...base, marketCategory: "corners", selectionKey: "under", line: 11.5 }), "win");
    assert.equal(settleOutcome({ ...base, marketCategory: "cards", selectionKey: "over", line: 5.5 }), "win");
    assert.equal(settleOutcome({ ...base, marketCategory: "shots-on-target", selectionKey: "over", line: 1.5, playerName: "x", playerShots: 2 }), "win");
    assert.equal(settleOutcome({ ...base, marketCategory: "shots-on-target", selectionKey: "over", line: 1.5, playerName: "x", playerShots: null }), null);
    assert.equal(settleOutcome({ ...base, marketCategory: "corners", selectionKey: "over", line: 9.5, stats: null }), null);
  });
});

describe("motor de predicciones (extremo a extremo)", () => {
  const BOOKS = ["b1", "b2", "b3", "b4", "b5", "b6"];
  const setup = (seed: number) => {
    const L = league(seed);
    const upcoming: UpcomingMatch[] = [];
    for (let i = 0; i < 30; i += 1) {
      const h = (i * 3) % 20;
      const a = (h + 1 + (i % 17)) % 20;
      upcoming.push({
        id: 10_000 + i, leagueCode: "premier-league", homeTeam: L.names[h]!, awayTeam: L.names[a]!,
        kickoff: new Date(NOW.getTime() + (2 + i) * 3_600_000),
      });
    }
    return { ...L, upcoming };
  };

  let quoteId = 1;
  function bookQuotes(match: UpcomingMatch, probs: { home: number; draw: number; away: number }, opts: {
    margin?: number; books?: string[]; capturedAt?: Date; boost?: { book: string; key: "home" | "draw" | "away"; factor: number };
    marketName?: string;
  } = {}): QuoteInput[] {
    const out: QuoteInput[] = [];
    for (const book of opts.books ?? BOOKS) {
      for (const [key, name] of [["home", "1"], ["draw", "X"], ["away", "2"]] as const) {
        let odds = 1 / (probs[key] * (1 + (opts.margin ?? 0.05)));
        if (opts.boost && opts.boost.book === book && opts.boost.key === key) odds *= opts.boost.factor;
        out.push({
          id: quoteId++, matchId: match.id, bookmaker: book, upstreamMarketId: "m1",
          marketCategory: "match-result", marketName: opts.marketName ?? "Full Time Result", selection: name,
          playerName: null, line: null, decimalOdds: odds,
          capturedAt: opts.capturedAt ?? new Date(NOW.getTime() - 3_600_000), sourceUpdatedAt: null,
        });
      }
    }
    return out;
  }
  const truth = (L: ReturnType<typeof setup>, m: UpcomingMatch) =>
    resultProbs(scoreMatrix(
      L.rates(L.names.indexOf(m.homeTeam), L.names.indexOf(m.awayTeam)).lh,
      L.rates(L.names.indexOf(m.homeTeam), L.names.indexOf(m.awayTeam)).la, 0));
  // dos veces: lh/la
  const run = (L: ReturnType<typeof setup>, quotes: QuoteInput[]) =>
    buildPredictions({ history: L.history, playerGames: [], matches: L.upcoming, quotes, now: NOW });

  it("con cuotas justas y margen normal casi no recomienda nada", () => {
    const L = setup(11);
    const quotes = L.upcoming.flatMap((m) => bookQuotes(m, truth(L, m)));
    const out = run(L, quotes);
    assert.ok(out.length <= 2, `falsos positivos: ${out.length}`);
  });

  it("detecta una casa con precio moderadamente alto y respeta los topes de EV", () => {
    const L = setup(11);
    const quotes = L.upcoming.flatMap((m) =>
      bookQuotes(m, truth(L, m), { margin: 0.02, boost: { book: "b3", key: "home", factor: 1.1 } }));
    const out = run(L, quotes);
    assert.ok(out.length > 0, "debería haber alguna recomendación");
    for (const bet of out) {
      assert.equal(bet.bookmaker, "b3");
      assert.ok(bet.expectedValuePct >= 4 && bet.expectedValuePct <= 20, `EV=${bet.expectedValuePct}`);
      assert.ok(bet.kellyFraction > 0 && bet.kellyFraction <= 0.02);
      assert.ok(bet.modelProbability > 0 && bet.modelProbability < 1);
    }
  });

  it("descarta precios atípicos que parecen cuotas viejas o erróneas", () => {
    const L = setup(11);
    const quotes = L.upcoming.flatMap((m) =>
      bookQuotes(m, truth(L, m), { margin: 0.02, boost: { book: "b3", key: "home", factor: 1.4 } }));
    assert.equal(run(L, quotes).length, 0);
  });

  it("ignora cuotas desactualizadas, mercados de 1ª parte y consensos con pocas casas", () => {
    const L = setup(11);
    const boost = { book: "b3", key: "home" as const, factor: 1.1 };
    const stale = L.upcoming.flatMap((m) =>
      bookQuotes(m, truth(L, m), { margin: 0.02, boost, capturedAt: new Date(NOW.getTime() - 20 * 3_600_000) }));
    assert.equal(run(L, stale).length, 0);
    const half = L.upcoming.flatMap((m) =>
      bookQuotes(m, truth(L, m), { margin: 0.02, boost, marketName: "1st Half 1X2" }));
    assert.equal(run(L, half).length, 0);
    const few = L.upcoming.flatMap((m) =>
      bookQuotes(m, truth(L, m), { margin: 0.02, boost, books: ["b3", "b4"] }));
    assert.equal(run(L, few).length, 0);
  });

  it("se abstiene con equipos sin historial suficiente", () => {
    const L = setup(11);
    const m = { ...L.upcoming[0]!, homeTeam: "Equipo Nuevo FC" };
    const quotes = bookQuotes(m, { home: 0.5, draw: 0.25, away: 0.25 }, { margin: 0.02, boost: { book: "b3", key: "home", factor: 1.1 } });
    const out = buildPredictions({ history: L.history, playerGames: [], matches: [m], quotes, now: NOW });
    assert.equal(out.length, 0);
  });

  it("usa solo la cuota más reciente de cada casa", () => {
    const L = setup(11);
    const m = L.upcoming[0]!;
    const p = truth(L, m);
    const fresh = bookQuotes(m, p, { margin: 0.02 });
    const oldHigh = bookQuotes(m, p, { margin: 0.02, books: ["b3"], capturedAt: new Date(NOW.getTime() - 5 * 3_600_000) })
      .map((q) => ({ ...q, decimalOdds: q.decimalOdds * 1.12 }));
    // La cuota alta es más vieja que la cuota normal de b3: no debe ganar.
    const out = buildPredictions({ history: L.history, playerGames: [], matches: [m], quotes: [...fresh, ...oldHigh], now: NOW });
    assert.equal(out.length, 0);
  });
});
