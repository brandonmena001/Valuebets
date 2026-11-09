import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modelConfig } from "./config";
import { buildPredictions, newDiagnostics, type QuoteInput, type UpcomingMatch } from "./predict";

modelConfig.mode = "reference";

const NOW = new Date("2026-10-20T12:00:00Z");
const match: UpcomingMatch = { id: 1, leagueCode: "serie-a", homeTeam: "Club A", awayTeam: "Club B", kickoff: new Date(NOW.getTime() + 10 * 3_600_000) };
const TRUTH = { "1": 0.45, X: 0.27, "2": 0.28 };
let id = 1;

function book(name: string, opts: { margin?: number; home?: number } = {}): QuoteInput[] {
  return (["1", "X", "2"] as const).map((sel) => ({
    id: id++, matchId: 1, bookmaker: name, upstreamMarketId: "m1", marketCategory: "match-result", marketName: "Full Time Result",
    selection: sel, playerName: null, line: null,
    decimalOdds: (1 / (TRUTH[sel] * (1 + (opts.margin ?? 0.05)))) * (sel === "1" ? opts.home ?? 1 : 1),
    capturedAt: new Date(NOW.getTime() - 3_600_000), sourceUpdatedAt: null,
  }));
}
const normal = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"].flatMap((n) => book(n));
const run = (quotes: QuoteInput[]) => {
  const diagnostics = newDiagnostics();
  const out = buildPredictions({ history: [], playerGames: [], matches: [match], quotes, now: NOW, diagnostics });
  return { out, d: diagnostics };
};

describe("modo referencia (consenso sin modelo)", () => {
  it("detecta una casa con precio por encima del consenso, sin necesitar historial ni modelo", () => {
    const { out } = run([...normal, ...book("SoftBook", { home: 1.09 })]);
    assert.equal(out.length, 1);
    const bet = out[0]!;
    assert.equal(bet.bookmaker, "SoftBook");
    assert.equal(bet.selectionKey, "home");
    assert.equal(bet.modelVersion, "ref-consensus-v1");
    assert.ok(bet.expectedValuePct >= 4 && bet.expectedValuePct <= 15, `EV=${bet.expectedValuePct}`);
    // sin ventaja demostrada: no se sugiere stake y la probabilidad es el consenso
    assert.equal(bet.kellyFraction, 0);
    assert.equal(bet.modelProbability, bet.marketProbability);
    assert.notEqual(bet.confidence, "high");
  });

  it("no propone exchanges como mejor precio (sus cuotas no incluyen comisión)", () => {
    const { out } = run([...normal, ...book("Betfair Exchange", { home: 1.09, margin: 0.01 })]);
    assert.equal(out.length, 0);
  });

  it("descarta cuotas atípicas por encima del tope (vieja o errónea)", () => {
    const { out, d } = run([...normal, ...book("Wrong", { home: 1.4 })]);
    assert.equal(out.length, 0);
    assert.ok((d.counters.rejectedPriceOutlier ?? 0) >= 1, JSON.stringify(d.counters));
  });

  it("el consenso excluye a la casa que ofrece el precio (leave-one-out)", () => {
    const { out } = run([...["Alpha", "Bravo", "Charlie", "Delta"].flatMap((n) => book(n)), ...book("Outlier", { home: 1.12 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.bookmaker, "Outlier");
  });

  it("exige suficientes casas para el consenso", () => {
    const { out } = run([...book("Alpha"), ...book("Bravo"), ...book("Soft", { home: 1.09 })]);
    assert.equal(out.length, 0);
  });

  it("con cuotas justas y margen normal no genera señales", () => {
    const { out } = run(["Alpha", "Bravo", "Charlie", "Delta", "Echo"].flatMap((n) => book(n)));
    assert.equal(out.length, 0);
  });
});
