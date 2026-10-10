import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { devigPower, negBinPmf, overProbability, poissonPmf, sum } from "./math";
import { resolveName } from "./names";
import { classifyQuote } from "./markets";
import { buildMatchSnapshot, buildPredictions, type HistoryMatch, type QuoteInput, type UpcomingMatch } from "./predict";
import { settleOutcome } from "./settle";
import {
  bttsProbability, effectiveProbability, lineOutcomeFromPmf, lineReturn, marginPmf, resultFor, splitLine,
} from "./lines";
import { parseCsv, parseFootballDataCsv, seasonCode, currentSeasonStartYear } from "../services/football-data-parse";
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
    // Las líneas enteras y de cuarto ahora sí se valoran (con push / medias ganancias).
    assert.equal(classifyQuote({ ...total, line: 2, marketName: "Total Goals" }, match)?.line, 2);
    assert.equal(classifyQuote({ ...total, line: 2.25, marketName: "Total Goals" }, match)?.line, 2.25);
    assert.equal(classifyQuote({ ...total, line: 2.3, marketName: "Total Goals" }, match), null);
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

describe("importación de football-data.co.uk", () => {
  const csv = "\uFEFFDiv,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HS,AS,HST,AST,HF,AF,HC,AC,HY,AY,HR,AR\r\n" +
    "E0,15/08/2025,20:00,Man United,Arsenal,0,1,A,10,15,2,5,12,10,5,8,2,1,0,0\r\n" +
    'E0,16/08/25,12:30,"Nott\'m Forest",Brentford,3,1,H,,,,,,,,,,,,\r\n' +
    "E0,22/08/2025,15:00,Chelsea,Fulham,,,,,,,,,,,,,,,\r\n" +
    ",,,,,,,,,,,,,,,,,,,\r\n";

  it("lee resultados y estadísticas por nombre de columna, con BOM y CRLF", () => {
    const rows = parseFootballDataCsv(csv, "premier-league", "2526");
    assert.equal(rows.length, 2); // el partido sin resultado se ignora
    const first = rows[0]!;
    assert.equal(first.homeTeam, "Man United");
    assert.deepEqual([first.homeScore, first.awayScore, first.homeCorners, first.awayCorners, first.homeShotsOnTarget, first.awayYellowCards], [0, 1, 5, 8, 2, 1]);
    // 15/08/2025 20:00 hora del Reino Unido (BST) = 19:00 UTC
    assert.equal(first.kickoff.toISOString(), "2025-08-15T19:00:00.000Z");
    const second = rows[1]!;
    assert.equal(second.homeTeam, "Nott'm Forest");
    assert.equal(second.homeCorners, null); // estadística ausente -> null, no 0
    assert.equal(second.kickoff.getUTCFullYear(), 2025); // año de 2 dígitos
  });

  it("devuelve vacío si faltan columnas esenciales y calcula el código de temporada", () => {
    assert.deepEqual(parseFootballDataCsv("a,b\n1,2", "la-liga", "2526"), []);
    assert.equal(parseCsv('a,"b,c",d\n1,2,3').length, 2);
    assert.equal(seasonCode(2026), "2627");
    assert.equal(currentSeasonStartYear(new Date("2026-10-04T00:00:00Z")), 2026);
    assert.equal(currentSeasonStartYear(new Date("2027-03-01T00:00:00Z")), 2026);
  });

  it("empata nombres cortos de football-data con los nombres completos de las casas", () => {
    const known = ["man city", "man united", "nott m forest", "wolves", "tottenham", "ath madrid", "ath bilbao",
      "ein frankfurt", "m gladbach", "bayern munich", "dortmund", "leverkusen", "espanol", "sociedad", "vallecano",
      "betis", "real madrid", "celta", "st pauli", "koln", "newcastle", "leeds", "west ham"];
    const expect: Array<[string, string]> = [
      ["Manchester City", "man city"], ["Manchester United", "man united"], ["Nottingham Forest", "nott m forest"],
      ["Wolverhampton Wanderers", "wolves"], ["Tottenham Hotspur", "tottenham"], ["Atletico Madrid", "ath madrid"],
      ["Athletic Club", "ath bilbao"], ["Athletic Bilbao", "ath bilbao"], ["Eintracht Frankfurt", "ein frankfurt"],
      ["Borussia Monchengladbach", "m gladbach"], ["Bayern München", "bayern munich"], ["Borussia Dortmund", "dortmund"],
      ["Bayer 04 Leverkusen", "leverkusen"], ["RCD Espanyol", "espanol"], ["Real Sociedad", "sociedad"],
      ["Rayo Vallecano", "vallecano"], ["Real Betis", "betis"], ["Celta Vigo", "celta"], ["FC St. Pauli", "st pauli"],
      ["1. FC Köln", "koln"], ["Newcastle United", "newcastle"], ["Leeds United", "leeds"], ["West Ham United", "west ham"],
    ];
    for (const [full, short] of expect) assert.equal(resolveName(full, known), short, `${full} -> ${short}`);
    assert.equal(resolveName("Real Madrid", known), "real madrid");
    assert.equal(resolveName("Equipo Desconocido", known), null);
  });
});

describe("líneas enteras, de cuarto y hándicap asiático", () => {
  it("reparte las líneas de cuarto en dos líneas vecinas", () => {
    assert.deepEqual(splitLine(2.5), [2.5]);
    assert.deepEqual(splitLine(2), [2]);
    assert.deepEqual(splitLine(2.25), [2, 2.5]);
    assert.deepEqual(splitLine(-0.75), [-1, -0.5]);
  });

  it("resultado de totales: push, media ganancia y media pérdida", () => {
    assert.equal(resultFor(2, 2, 1), "push");
    assert.equal(resultFor(3, 2, 1), "win");
    assert.equal(resultFor(1, 2, -1), "win");
    assert.equal(resultFor(2, 2.25, 1), "half-loss"); // más de 2.25 con 2 goles
    assert.equal(resultFor(3, 2.25, 1), "win");
    assert.equal(resultFor(2, 2.25, -1), "half-win");
    assert.equal(resultFor(3, 2.75, 1), "half-win"); // más de 2.75 con 3 goles
    assert.equal(resultFor(3, 2.75, -1), "half-loss");
    assert.equal(resultFor(2, 2.75, 1), "loss");
  });

  it("hándicap asiático al local (umbral = -línea)", () => {
    const home = (margin: number, line: number) => resultFor(margin, -line, 1);
    const away = (margin: number, line: number) => resultFor(margin, -line, -1);
    assert.equal(home(1, -0.5), "win");
    assert.equal(home(0, -0.5), "loss");
    assert.equal(home(1, -1), "push");
    assert.equal(home(2, -1), "win");
    assert.equal(home(0, -0.25), "half-loss");
    assert.equal(home(1, -0.25), "win");
    assert.equal(home(0, 0), "push");
    assert.equal(home(-1, 0.75), "half-loss"); // +0.75 perdiendo por 1
    assert.equal(home(0, 0.75), "win");
    assert.equal(home(1, -0.75), "half-win"); // -0.75 ganando por 1
    assert.equal(away(-1, -0.5), "win"); // visitante con +0.5 y gana por 1
    assert.equal(away(0, -0.5), "win");
    assert.equal(away(1, -0.5), "loss");
  });

  it("ganancia neta por resultado", () => {
    assert.ok(Math.abs(lineReturn("win", 2.1) - 1.1) < 1e-12);
    assert.ok(Math.abs(lineReturn("half-win", 2.1) - 0.55) < 1e-12);
    assert.equal(lineReturn("push", 2.1), 0);
    assert.equal(lineReturn("half-loss", 2.1), -0.5);
    assert.equal(lineReturn("loss", 2.1), -1);
  });

  const lh = 1.6;
  const la = 1.1;
  const matrix = scoreMatrix(lh, la, 0);

  it("sin push, la probabilidad efectiva coincide con la de la línea .5", () => {
    const pmf = totalCountPmf(lh, la, 0);
    const eff = effectiveProbability(lineOutcomeFromPmf(pmf, 0, 2.5, 1));
    assert.ok(Math.abs(eff.prob - overProbability(pmf, 2.5)) < 1e-9);
    assert.ok(Math.abs(eff.risk - 1) < 1e-9);
  });

  it("el hándicap de local y visitante son complementarios y el EV es consistente", () => {
    const { pmf, offset } = marginPmf(matrix);
    assert.ok(Math.abs(sum(pmf) - 1) < 1e-9);
    for (const line of [-1.25, -1, -0.75, -0.25, 0, 0.5, 1]) {
      const h = effectiveProbability(lineOutcomeFromPmf(pmf, offset, -line, 1));
      const a = effectiveProbability(lineOutcomeFromPmf(pmf, offset, -line, -1));
      assert.ok(Math.abs(h.prob + a.prob - 1) < 1e-9, `línea ${line}`);
      assert.ok(Math.abs(h.risk - a.risk) < 1e-9, `riesgo línea ${line}`);
      // EV por simulación exacta sobre la distribución == risk * (prob * cuota - 1)
      const odds = 2.2;
      let ev = 0;
      for (let k = 0; k < pmf.length; k += 1) ev += pmf[k]! * lineReturn(resultFor(k + offset, -line, 1), odds);
      assert.ok(Math.abs(ev - h.risk * (h.prob * odds - 1)) < 1e-9, `EV línea ${line}`);
    }
    // En una línea entera hay push: riesgo < 1.
    const draw = effectiveProbability(lineOutcomeFromPmf(pmf, offset, 0, 1));
    assert.ok(draw.risk < 0.9);
  });

  it("ambos anotan coincide con el cálculo independiente (rho = 0)", () => {
    const expected = (1 - Math.exp(-lh)) * (1 - Math.exp(-la));
    assert.ok(Math.abs(bttsProbability(matrix) - expected) < 1e-6);
  });

  it("clasifica ambos anotan y hándicap asiático, y descarta lo ambiguo", () => {
    const match = { homeTeam: "Arsenal", awayTeam: "Chelsea" };
    const base = { playerName: null, line: null, upstreamMarketId: null, marketCategory: "goals" };
    assert.equal(classifyQuote({ ...base, marketName: "Both Teams To Score", selection: "Yes" }, match)?.selectionKey, "yes");
    assert.equal(classifyQuote({ ...base, marketName: "Both Teams to Score", selection: "No" }, match)?.selectionKey, "no");
    assert.equal(classifyQuote({ ...base, marketName: "1st Half Both Teams To Score", selection: "Yes" }, match), null);
    assert.equal(classifyQuote({ ...base, marketName: "Both Teams To Score & Over 2.5", selection: "Yes" }, match), null);
    const ah = { ...base, marketName: "Asian Handicap", line: -0.75 };
    const home = classifyQuote({ ...ah, selection: "Arsenal" }, match)!;
    assert.equal(home.kind, "handicap");
    assert.equal(home.selectionKey, "home");
    assert.equal(classifyQuote({ ...ah, selection: "Chelsea" }, match)?.selectionKey, "away");
    assert.equal(classifyQuote({ ...ah, selection: "Draw" }, match), null);
    assert.equal(classifyQuote({ ...ah, selection: "Arsenal", line: null }, match), null);
    assert.equal(classifyQuote({ ...ah, selection: "Arsenal", line: -0.6 }, match), null);
    assert.equal(classifyQuote({ ...ah, marketName: "European Handicap", selection: "Arsenal" }, match), null);
    assert.equal(classifyQuote({ ...ah, marketName: "Asian Handicap Corners", selection: "Arsenal" }, match), null);
    assert.equal(classifyQuote({ ...ah, marketName: "1st Half Asian Handicap", selection: "Arsenal" }, match), null);
  });

  it("liquida ambos anotan, hándicap y líneas enteras (push y medias)", () => {
    const base = { playerName: null, stats: null, playerShots: null };
    const at = (homeScore: number, awayScore: number) => ({ ...base, homeScore, awayScore });
    assert.equal(settleOutcome({ ...at(2, 1), marketCategory: "goals", selectionKey: "yes", line: null }), "win");
    assert.equal(settleOutcome({ ...at(2, 0), marketCategory: "goals", selectionKey: "yes", line: null }), "loss");
    assert.equal(settleOutcome({ ...at(0, 0), marketCategory: "goals", selectionKey: "no", line: null }), "win");
    assert.equal(settleOutcome({ ...at(2, 0), marketCategory: "match-result", selectionKey: "home", line: -2 }), "push");
    assert.equal(settleOutcome({ ...at(2, 0), marketCategory: "match-result", selectionKey: "home", line: -1.75 }), "half-win");
    assert.equal(settleOutcome({ ...at(1, 1), marketCategory: "goals", selectionKey: "away", line: 0 }), "push");
    assert.equal(settleOutcome({ ...at(1, 1), marketCategory: "goals", selectionKey: "away", line: -0.25 }), "half-win");
    assert.equal(settleOutcome({ ...at(1, 1), marketCategory: "goals", selectionKey: "over", line: 2 }), "push");
    assert.equal(settleOutcome({ ...at(2, 1), marketCategory: "goals", selectionKey: "over", line: 3 }), "push");
    assert.equal(settleOutcome({ ...at(2, 1), marketCategory: "goals", selectionKey: "under", line: 3.25 }), "half-win");
    assert.equal(settleOutcome({ ...at(2, 1), marketCategory: "goals", selectionKey: "over", line: 2.75 }), "half-win");
    // El 1X2 sigue igual (sin línea).
    assert.equal(settleOutcome({ ...at(2, 1), marketCategory: "match-result", selectionKey: "home", line: null }), "win");
  });
});

describe("mercados nuevos de extremo a extremo (datos simulados)", () => {
  const BOOKS = ["b1", "b2", "b3", "b4", "b5", "b6"];
  const L = league(21);
  const upcoming: UpcomingMatch[] = [];
  for (let i = 0; i < 30; i += 1) {
    const h = (i * 3) % 20;
    const a = (h + 1 + (i % 17)) % 20;
    upcoming.push({
      id: 20_000 + i, leagueCode: "premier-league", homeTeam: L.names[h]!, awayTeam: L.names[a]!,
      kickoff: new Date(NOW.getTime() + (2 + i) * 3_600_000),
    });
  }
  const matrixOf = (m: UpcomingMatch) => {
    const r = L.rates(L.names.indexOf(m.homeTeam), L.names.indexOf(m.awayTeam));
    return scoreMatrix(r.lh, r.la, 0);
  };
  let id = 1;
  /** Cuotas a dos vías con margen y un impulso opcional en una casa y selección. */
  function twoWay(m: UpcomingMatch, name: string, labels: [string, string], line: number | null, p: number, boost?: number): QuoteInput[] {
    const out: QuoteInput[] = [];
    for (const book of BOOKS) {
      [p, 1 - p].forEach((prob, k) => {
        let odds = 1 / (prob * 1.02);
        if (book === "b3" && k === 0 && boost) odds *= boost;
        out.push({
          id: id++, matchId: m.id, bookmaker: book, upstreamMarketId: "mx", marketCategory: "goals", marketName: name,
          selection: labels[k]!, playerName: null, line, decimalOdds: odds,
          capturedAt: new Date(NOW.getTime() - 3_600_000), sourceUpdatedAt: null,
        });
      });
    }
    return out;
  }
  const run = (quotes: QuoteInput[]) =>
    buildPredictions({ history: L.history, playerGames: [], matches: upcoming, quotes, now: NOW });

  it("ambos anotan: con precios justos casi no recomienda; con una casa alta sí", () => {
    const fair = upcoming.flatMap((m) => twoWay(m, "Both Teams To Score", ["Yes", "No"], null, bttsProbability(matrixOf(m))));
    assert.ok(run(fair).length <= 2);
    const boosted = upcoming.flatMap((m) => twoWay(m, "Both Teams To Score", ["Yes", "No"], null, bttsProbability(matrixOf(m)), 1.1));
    const out = run(boosted);
    assert.ok(out.length > 0);
    for (const bet of out) {
      assert.equal(bet.bookmaker, "b3");
      assert.equal(bet.selectionKey, "yes");
      assert.ok(bet.expectedValuePct >= 4 && bet.expectedValuePct <= 20);
    }
  });

  it("hándicap asiático -0.5 y línea entera: recomienda y reduce el EV por el push", () => {
    const peff = (m: UpcomingMatch, line: number) => {
      const { pmf, offset } = marginPmf(matrixOf(m));
      return effectiveProbability(lineOutcomeFromPmf(pmf, offset, -line, 1)).prob;
    };
    const quotesFor = (line: number) =>
      upcoming.flatMap((m) => twoWay(m, "Asian Handicap", [m.homeTeam, m.awayTeam], line, peff(m, line), 1.1));
    const half = run(quotesFor(-0.5));
    assert.ok(half.length > 0);
    for (const bet of half) {
      assert.equal(bet.selectionKey, "home");
      assert.equal(bet.line, -0.5);
      assert.ok(bet.expectedValuePct >= 4 && bet.expectedValuePct <= 20);
    }
    const whole = run(quotesFor(0));
    for (const bet of whole) {
      // Con push posible, el EV real es menor que prob * cuota - 1 (solo parte de la apuesta está en juego).
      const naive = (bet.modelProbability * bet.decimalOdds - 1) * 100;
      assert.ok(bet.expectedValuePct < naive, `ev=${bet.expectedValuePct} naive=${naive}`);
      assert.ok(bet.expectedValuePct > 0.5 * naive);
    }
  });

  it("totales con línea entera y de cuarto se valoran y respetan los topes", () => {
    const peff = (m: UpcomingMatch, line: number) => {
      const pmf = totalCountPmf(...(() => {
        const r = L.rates(L.names.indexOf(m.homeTeam), L.names.indexOf(m.awayTeam));
        return [r.lh, r.la, 0] as const;
      })());
      return effectiveProbability(lineOutcomeFromPmf(pmf, 0, line, 1)).prob;
    };
    for (const line of [2, 2.25, 2.75, 3]) {
      const quotes = upcoming.flatMap((m) =>
        twoWay(m, "Total Goals", ["Over", "Under"], line, peff(m, line), 1.1));
      for (const bet of run(quotes)) {
        assert.equal(bet.line, line);
        assert.ok(bet.expectedValuePct >= 4 && bet.expectedValuePct <= 20);
        assert.ok(bet.kellyFraction > 0 && bet.kellyFraction <= 0.02);
      }
    }
  });
});

describe("ficha de partido con mezcla de mercado", () => {
  const L = league(33);
  const match = { id: 30_001, leagueCode: "premier-league", homeTeam: L.names[2]!, awayTeam: L.names[9]! };
  const r = L.rates(2, 9);
  const m = scoreMatrix(r.lh, r.la, 0);
  const truth = resultProbs(m);
  let qid = 1;
  const quote = (book: string, name: string, selection: string, odds: number, line: number | null, category = "goals"): QuoteInput => ({
    id: qid++, matchId: match.id, bookmaker: book, upstreamMarketId: name, marketCategory: category, marketName: name,
    selection, playerName: null, line, decimalOdds: odds, capturedAt: new Date(NOW.getTime() - 3_600_000), sourceUpdatedAt: null,
  });
  const books = (n: number) => ["b1", "b2", "b3", "b4", "b5", "b6"].slice(0, n);
  const quotesFor = (n: number): QuoteInput[] =>
    books(n).flatMap((b) => [
      quote(b, "Full Time Result", "1", 1 / (truth.home * 1.04), null, "match-result"),
      quote(b, "Full Time Result", "X", 1 / (truth.draw * 1.04), null, "match-result"),
      quote(b, "Full Time Result", "2", 1 / (truth.away * 1.04), null, "match-result"),
      quote(b, "Both Teams To Score", "Yes", 1 / (0.62 * 1.04), null),
      quote(b, "Both Teams To Score", "No", 1 / (0.38 * 1.04), null),
      quote(b, "Total Goals", "Over 2.5", 1 / (0.52 * 1.04), 2.5),
      quote(b, "Total Goals", "Under 2.5", 1 / (0.48 * 1.04), 2.5),
    ]);

  it("sin cuotas devuelve solo el modelo puro (blended = null)", () => {
    const snap = buildMatchSnapshot({ history: L.history, match, now: NOW })!;
    assert.ok(snap);
    assert.equal(snap.blended, null);
  });

  it("con consenso mezcla modelo y mercado con el peso del 1X2", () => {
    const pure = buildMatchSnapshot({ history: L.history, match, now: NOW })!;
    const snap = buildMatchSnapshot({ history: L.history, match, now: NOW, quotes: quotesFor(6) })!;
    const b = snap.blended!;
    assert.ok(b.result);
    assert.deepEqual(snap.result, pure.result); // el modelo puro no cambia
    const p = b.result!.probs;
    assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 1e-9);
    assert.equal(b.result!.bookmakers, 6);
    assert.ok(b.result!.modelWeight > 0 && b.result!.modelWeight <= 0.35);
    for (const k of ["home", "draw", "away"] as const) {
      const lo = Math.min(pure.result[k], b.result!.market[k]);
      const hi = Math.max(pure.result[k], b.result!.market[k]);
      assert.ok(p[k] >= lo - 1e-9 && p[k] <= hi + 1e-9, `${k} fuera del intervalo modelo-mercado`);
    }
    const fairBtts = devigPower([1 / (0.62 * 1.04), 1 / (0.38 * 1.04)])![0]!; // el margen se quita con el método de potencia
    assert.ok(b.btts && Math.abs(b.btts.marketYes - fairBtts) < 1e-9);
    const over25 = b.goalLines.find((x) => x.line === 2.5)!;
    assert.ok(Math.abs(over25.marketOver - devigPower([1 / (0.52 * 1.04), 1 / (0.48 * 1.04)])![0]!) < 1e-9);
  });

  it("con menos casas que el mínimo no mezcla", () => {
    const snap = buildMatchSnapshot({ history: L.history, match, now: NOW, quotes: quotesFor(2) })!;
    assert.equal(snap.blended, null);
  });

  it("ignora cuotas de otros partidos y las desactualizadas", () => {
    const other = quotesFor(6).map((q) => ({ ...q, matchId: 99 }));
    assert.equal(buildMatchSnapshot({ history: L.history, match, now: NOW, quotes: other })!.blended, null);
    const stale = quotesFor(6).map((q) => ({ ...q, capturedAt: new Date(NOW.getTime() - 30 * 3_600_000) }));
    assert.equal(buildMatchSnapshot({ history: L.history, match, now: NOW, quotes: stale })!.blended, null);
  });
});
