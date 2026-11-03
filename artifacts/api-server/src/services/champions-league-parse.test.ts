import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseChampionsLeagueResults } from "./champions-league-parse";

describe("parseChampionsLeagueResults", () => {
  it("reads completed fixtures, strips country tags, and advances the year after December", () => {
    const text = `= UEFA Champions League 2024/25

▪ League, Matchday 1
Tue Sep 17 2024
  18:45  BSC Young Boys (SUI)    v Aston Villa FC (ENG)  0-3 (0-2)
  21:00  Real Madrid CF (ESP)    v VfB Stuttgart (GER)  3-1 (0-0)

▪ League, Matchday 7
Wed Jan 22
  21:00  PSV (NED)               v Liverpool FC (ENG)   3-2 (1-0)
  21:00  Future Home (ENG)       v Future Away (ESP)
`;
    const rows = parseChampionsLeagueResults(
      text,
      2024,
      new Date("2025-02-01T00:00:00Z"),
    );

    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.season, "2024/25");
    assert.equal(rows[0]?.homeTeam, "BSC Young Boys");
    assert.equal(rows[0]?.awayTeam, "Aston Villa FC");
    assert.equal(rows[0]?.homeScore, 0);
    assert.equal(rows[0]?.awayScore, 3);
    assert.equal(rows[2]?.kickoff.toISOString(), "2025-01-22T12:00:00.000Z");
    assert.equal(rows[2]?.homeTeam, "PSV");
    assert.equal(rows[2]?.homeScore, 3);
    assert.equal(rows[2]?.awayScore, 2);
  });

  it("does not return future matches or invalid date lines", () => {
    const text = `Tue Feb 31 2025
  21:00  Invalid Date FC (ENG) v Invalid Away FC (ESP) 1-0
Tue May 20 2025
  21:00  Future Home FC (ENG) v Future Away FC (ESP) 1-0
`;
    assert.deepEqual(
      parseChampionsLeagueResults(
        text,
        2024,
        new Date("2025-05-01T00:00:00Z"),
      ),
      [],
    );
  });
});
