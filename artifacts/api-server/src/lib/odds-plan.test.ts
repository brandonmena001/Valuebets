import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ODDS_MIN_GAP_MS, paceGapMs, planOddsFetch, quotesDigest } from "./odds-plan";

const NOW = new Date("2026-10-10T12:00:00Z");
const H = 3_600_000;
const L = ["premier-league", "la-liga", "bundesliga"];
const at = (hours: number, leagueCode: string) => ({ leagueCode, kickoff: new Date(NOW.getTime() + hours * H) });
const base = { allLeagues: L, now: NOW, lastFetchAt: 0, lastDiscoveryAt: 0, scheduled: true, calendarKnown: true };

describe("planOddsFetch", () => {
  it("consulta solo las ligas con partidos en 48 h", () => {
    const plan = planOddsFetch({ ...base, calendar: [at(5, "bundesliga"), at(30, "la-liga"), at(100, "premier-league")] });
    assert.equal(plan.fetch, true);
    assert.deepEqual(plan.leagues, ["la-liga", "bundesliga"]);
    assert.deepEqual([plan.near, plan.far], [1, 1]);
  });
  it("no gasta llamadas si no hay partidos y el calendario es conocido", () => {
    const plan = planOddsFetch({ ...base, calendar: [at(72, "la-liga")] });
    assert.deepEqual([plan.fetch, plan.leagues], [false, []]);
  });
  it("solo 24-48 h: una vez cada 24 h en programadas, siempre en manuales", () => {
    const calendar = [at(30, "la-liga")];
    assert.equal(planOddsFetch({ ...base, calendar, lastFetchAt: NOW.getTime() - 8 * H }).fetch, false);
    assert.equal(planOddsFetch({ ...base, calendar, lastFetchAt: NOW.getTime() - 25 * H }).fetch, true);
    assert.equal(planOddsFetch({ ...base, calendar, lastFetchAt: NOW.getTime() - 1 * H, scheduled: false }).fetch, true);
  });
  it("calendario desconocido: descubrimiento como máximo cada 24 h", () => {
    const unknown = { ...base, calendar: [], calendarKnown: false };
    assert.deepEqual(planOddsFetch(unknown).leagues, L);
    assert.equal(planOddsFetch({ ...unknown, lastDiscoveryAt: NOW.getTime() - 2 * H }).fetch, false);
  });
  it("ignora ligas no elegidas y partidos ya iniciados hace más de 2 h", () => {
    const plan = planOddsFetch({ ...base, calendar: [at(5, "serie-a"), at(-5, "la-liga")] });
    assert.equal(plan.fetch, false);
  });
});

describe("quotesDigest", () => {
  const q = (odds: number, selection = "Home") => ({ bookmaker: "B", marketName: "1X2", selection, playerName: null, line: null, decimalOdds: odds, sourceUpdatedAt: null });
  it("no depende del orden y cambia si cambia una cuota", () => {
    assert.equal(quotesDigest([q(2), q(3, "Away")]), quotesDigest([q(3, "Away"), q(2)]));
    assert.notEqual(quotesDigest([q(2)]), quotesDigest([q(2.05)]));
  });
});

describe("paceGapMs", () => {
  const day10 = new Date("2026-10-10T17:00:00Z");
  it("con la cuota de tu caso (117/200 el día 10) estira la separación a más de 7 h", () => {
    const gap = paceGapMs({ used: 117, cap: 200, now: day10 });
    assert.ok(gap > ODDS_MIN_GAP_MS && gap < 24 * H, `gap=${gap / H} h`);
  });
  it("con cuota de sobra usa el mínimo de 7 h", () => {
    assert.equal(paceGapMs({ used: 10, cap: 200, now: day10 }), ODDS_MIN_GAP_MS);
  });
  it("sin cuota suficiente no permite sincronizar", () => {
    assert.equal(paceGapMs({ used: 195, cap: 200, now: day10 }), Number.POSITIVE_INFINITY);
  });
});
