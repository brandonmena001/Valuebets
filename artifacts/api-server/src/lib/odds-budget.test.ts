import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixedIntervalCalls, planCaptures } from "./odds-budget";

const d = (iso: string) => new Date(iso);
// Sábado SIMULADO con agrupaciones típicas de las ligas (UTC): no es el calendario real.
const weekend = [
  "2026-10-17T14:00:00Z", "2026-10-17T14:00:00Z", "2026-10-17T14:00:00Z", "2026-10-17T15:30:00Z",
  "2026-10-17T16:30:00Z", "2026-10-17T16:30:00Z", "2026-10-17T19:00:00Z",
].map(d);

describe("planCaptures", () => {
  it("una captura 3 h antes sirve a los partidos que empiezan en la ventana de 1 a 5 h", () => {
    const plan = planCaptures(weekend);
    assert.equal(plan.captures[0]!.at.toISOString(), "2026-10-17T11:00:00.000Z");
    assert.deepEqual(plan.captures.map((c) => c.covers), [4, 2, 1]);
    assert.equal(plan.matches, 7);
    assert.equal(plan.uncovered, 0);
  });
  it("gasto = capturas x casas + fijo, y nunca pasa del tope", () => {
    const plan = planCaptures(weekend, { callsPerCapture: 2, overheadCalls: 17 });
    assert.equal(plan.calls, plan.captures.length * 2 + 17);
    assert.equal(plan.withinCap, true);
    const tight = planCaptures(weekend, { cap: 21 });
    assert.ok(tight.calls <= 21 && tight.captures.length === 2 && tight.uncovered === 1);
  });
  it("sin partidos no gasta capturas", () => {
    assert.deepEqual(planCaptures([]).captures, []);
  });
  it("intervalo fijo de 8 h con 2 casas durante 30 días", () => {
    assert.equal(fixedIntervalCalls(30, 8), 197);
  });
});
