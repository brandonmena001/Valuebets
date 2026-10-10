import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPredictions, newDiagnostics, type HistoryMatch, type QuoteInput, type UpcomingMatch } from "./predict";

const NOW = new Date("2026-10-10T12:00:00Z");
const DAY = 86_400_000;
const teams = Array.from({ length: 12 }, (_, i) => `club ${String.fromCharCode(97 + i)}`);

function history(): HistoryMatch[] {
  const rows: HistoryMatch[] = [];
  let id = 1;
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pois = (l: number) => { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
  for (let r = 0; r < 3; r++) for (const h of teams) for (const a of teams) if (h !== a) {
    rows.push({ id: id++, leagueCode: "premier-league", homeTeam: h, awayTeam: a, kickoff: new Date(NOW.getTime() - (300 - id / 4) * DAY),
      homeScore: pois(1.5), awayScore: pois(1.2), homeCorners: null, awayCorners: null, homeYellowCards: null, awayYellowCards: null,
      homeRedCards: null, awayRedCards: null, homeShotsOnTarget: null, awayShotsOnTarget: null });
  }
  return rows;
}

const match: UpcomingMatch = { id: 1, leagueCode: "premier-league", homeTeam: "Club A", awayTeam: "Club B", kickoff: new Date(NOW.getTime() + 10 * 3_600_000) };
let qid = 1;
function quotes(books: string[], opts: { name?: string; ageHours?: number } = {}): QuoteInput[] {
  const out: QuoteInput[] = [];
  for (const book of books) for (const [sel, odds] of [["1", 2.0], ["X", 3.5], ["2", 4.0]] as const) {
    out.push({ id: qid++, matchId: 1, bookmaker: book, upstreamMarketId: "m1", marketCategory: "match-result", marketName: opts.name ?? "Full Time Result",
      selection: sel, playerName: null, line: null, decimalOdds: odds, capturedAt: new Date(NOW.getTime() - (opts.ageHours ?? 1) * 3_600_000), sourceUpdatedAt: null });
  }
  return out;
}
const run = (q: QuoteInput[]) => {
  const diagnostics = newDiagnostics();
  const out = buildPredictions({ history: history(), playerGames: [], matches: [match], quotes: q, now: NOW, diagnostics });
  return { out, d: diagnostics };
};

describe("embudo de diagnóstico", () => {
  it("cuenta cuotas viejas y partidos sin cuotas frescas", () => {
    const { d } = run(quotes(["a", "b", "c", "d"], { ageHours: 30 }));
    assert.equal(d.counters.quoteTooOld, 12);
    assert.equal(d.counters.matchNoFreshQuotes, 1);
    assert.equal(d.counters.accepted ?? 0, 0);
  });

  it("lista los mercados no reconocidos con su conteo", () => {
    const { d } = run([...quotes(["a", "b", "c", "d"]), ...quotes(["a", "b", "c", "d"], { name: "1st Half 1X2" })]);
    assert.equal(d.unsupportedMarkets["match-result | 1st Half 1X2"], 12);
    assert.equal(d.counters.quoteSupported, 12);
  });

  it("detecta consenso insuficiente y reporta cuántas casas se vieron", () => {
    const { d } = run(quotes(["a", "b"]));
    assert.equal(d.counters.noConsensus, 3);
    assert.deepEqual(d.bookmakersSeen, { "2": 3 });
  });

  it("con casas suficientes llega a las etapas de valor y todo selección queda contada", () => {
    const { d } = run(quotes(["a", "b", "c", "d"]));
    assert.equal(d.counters.selections, 3);
    const accounted = (d.counters.noConsensus ?? 0) + (d.counters.noModel ?? 0) + (d.counters.accepted ?? 0) +
      Object.entries(d.counters).filter(([k]) => k.startsWith("rejected")).reduce((s, [, v]) => s + v, 0);
    assert.equal(accounted, 3, JSON.stringify(d.counters));
  });
});
