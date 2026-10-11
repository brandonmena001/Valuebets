import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractQuotes, type OddsPapiMarket } from "./oddspapi";

// Evento SIMULADO con la forma documentada de /v4/odds (no son datos reales).
const markets = new Map<string, OddsPapiMarket>([
  ["101", { id: "101", name: "Full Time Result", playerProp: false, handicap: null, outcomeNames: { "101": "Home", "102": "Draw" } }],
]);
const bookmakers = [{ slug: "betplay", name: "BetPlay" }];
const event = {
  updatedAt: "2026-10-10T09:00:00Z",
  bookmakerOdds: {
    betplay: {
      markets: {
        "101": {
          marketActive: true,
          outcomes: {
            "101": { players: { "0": { price: 2.1, active: true, changedAt: "2026-10-10T10:00:00Z", bookmakerChangedAt: "2026-10-10T08:30:00Z" } } },
            "102": { players: { "0": { price: 3.4, active: true, changedAt: "2026-10-10T10:00:00Z" } } },
          },
        },
      },
    },
  },
};

describe("extractQuotes: horas de cambio", () => {
  const [home, draw] = extractQuotes(event, bookmakers, markets);
  it("conserva source_updated_at como changedAt (hora de OddsPapi) para no reescribir el historial", () => {
    assert.equal(home!.sourceUpdatedAt!.toISOString(), "2026-10-10T10:00:00.000Z");
  });
  it("guarda aparte la hora que reporta la casa cuando existe", () => {
    assert.equal(home!.bookmakerChangedAt!.toISOString(), "2026-10-10T08:30:00.000Z");
  });
  it("deja null la hora de la casa cuando OddsPapi no la envía", () => {
    assert.equal(draw!.bookmakerChangedAt, null);
    assert.equal(draw!.decimalOdds, 3.4);
  });
});
