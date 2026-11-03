import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { leagueForName } from "./oddspapi";

describe("leagueForName", () => {
  it("recognizes UEFA Champions League tournament names", () => {
    assert.equal(leagueForName("UEFA Champions League"), "champions-league");
    assert.equal(leagueForName("Champions League"), "champions-league");
    assert.equal(leagueForName("Champions League UEFA"), "champions-league");
  });

  it("does not classify women's, qualifying, youth, or other confederation events as UCL", () => {
    assert.equal(leagueForName("UEFA Women's Champions League"), null);
    assert.equal(leagueForName("UEFA Champions League Qualification"), null);
    assert.equal(leagueForName("UEFA Youth Champions League U19"), null);
    assert.equal(leagueForName("AFC Champions League"), null);
    assert.equal(leagueForName("Champions League AFC"), null);
  });
});
