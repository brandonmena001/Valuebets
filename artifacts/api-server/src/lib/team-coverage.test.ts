import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findUnmatchedTeams } from "./team-coverage";

// Nombres reales de football-data (muestras del usuario) como historial de la Bundesliga.
const history = new Map([["bundesliga", ["Bayern Munich", "RB Leipzig", "Ein Frankfurt", "Werder Bremen", "Dortmund"]]]);

describe("findUnmatchedTeams", () => {
  it("reporta equipos sin coincidencia, una sola vez y ordenados", () => {
    const result = findUnmatchedTeams(
      [
        { leagueCode: "bundesliga", team: "Zzz Wanderers" },
        { leagueCode: "bundesliga", team: "Zzz Wanderers" },
        { leagueCode: "bundesliga", team: "Bayern Munich" },
        { leagueCode: "la-liga", team: "Girona" },
      ],
      history,
    );
    assert.deepEqual(result, [
      { leagueCode: "bundesliga", team: "Zzz Wanderers", reason: "sin coincidencia" },
      { leagueCode: "la-liga", team: "Girona", reason: "sin historial" },
    ]);
  });
  it("un nombre idéntico al del historial siempre empareja", () => {
    assert.deepEqual(findUnmatchedTeams([{ leagueCode: "bundesliga", team: "Werder Bremen" }], history), []);
  });
});
