import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resultProbs, scoreMatrix } from "../../artifacts/api-server/src/model/strength";
import { bootstrapMean, evaluate, readRows, walkForward, type Row } from "./gate-lib";

function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  const pois = (l: number) => { const L = Math.exp(-l); let k = 0, p = 1; do { k += 1; p *= u(); } while (p > L); return k - 1; };
  return { u, n, pois };
}

type World = "soft" | "efficient";

/** Liga simulada: 20 equipos con fuerzas fijas, 4 temporadas, cuotas de varias fuentes con ruido controlado. */
function simulate(seed: number, league: string, world: World, softNoise = 0.1): Row[] {
  const r = rng(seed);
  const teams = 20;
  const att = Array.from({ length: teams }, () => Math.exp(0.28 * r.n()));
  const def = Array.from({ length: teams }, () => Math.exp(0.22 * r.n()));
  const rows: Row[] = [];
  for (let s = 0; s < 4; s += 1) {
    const start = Date.UTC(2022 + s, 7, 10);
    const pairs: Array<[number, number]> = [];
    for (let h = 0; h < teams; h += 1) for (let a = 0; a < teams; a += 1) if (h !== a) pairs.push([h, a]);
    pairs.sort(() => r.u() - 0.5);
    pairs.forEach(([h, a], i) => {
      const lh = 1.15 * 1.25 * att[h]! * def[a]!;
      const la = 1.15 * att[a]! * def[h]!;
      const probs = resultProbs(scoreMatrix(lh, la, 0));
      const truth = [probs.home, probs.draw, probs.away];
      const noisy = (sigma: number) => {
        const q = truth.map((p) => p * Math.exp(sigma * r.n()));
        const t = q[0]! + q[1]! + q[2]!;
        return q.map((x) => x / t);
      };
      const odds = (p: number[], margin: number) => p.map((x) => 1 / (x * (1 + margin))) as [number, number, number];
      const avg = world === "soft" ? noisy(0.04) : truth;
      const b365 = world === "soft" ? noisy(softNoise) : truth;
      const b365Odds = odds(b365, 0.055);
      const avgOdds = odds(avg, 0.05);
      rows.push({
        league, season: String(s), kickoff: new Date(start + (i / pairs.length) * 280 * 86_400_000),
        home: `Equipo ${h}`, away: `Equipo ${a}`, hg: r.pois(lh), ag: r.pois(la),
        pinClose: odds(truth, 0.025), b365Pre: b365Odds, avgPre: avgOdds,
        maxPre: b365Odds.map((x, k) => Math.max(x, avgOdds[k]! * 1.02)) as [number, number, number],
        avgClose: odds(truth, 0.04),
      });
    });
  }
  return rows;
}

describe("compuerta: lectura de CSV", () => {
  it("lee por nombre de columna, ignora filas sin resultado y deja undefined lo que falta", () => {
    const csv = [
      "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,PSCH,PSCD,PSCA,B365H,B365D,B365A,AvgH,AvgD,AvgA",
      "E0,15/08/2025,20:00,Man City,Arsenal,2,1,1.9,3.6,4.2,2.0,3.5,4.0,1.95,3.55,4.1",
      "E0,16/08/25,12:30,Chelsea,Fulham,0,0,,,,2.1,3.4,3.8,2.05,3.4,3.7",
      "E0,22/08/2025,15:00,Everton,Burnley,,,,,,,,,,,",
    ].join("\r\n");
    const rows = readRows(csv, "E0", "2526");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0]!.pinClose, [1.9, 3.6, 4.2]);
    assert.equal(rows[1]!.pinClose, undefined);
    assert.deepEqual(rows[1]!.b365Pre, [2.1, 3.4, 3.8]);
    assert.equal(rows[0]!.kickoff.toISOString(), "2025-08-15T20:00:00.000Z");
    assert.deepEqual(readRows("a,b\n1,2", "E0", "2526"), []);
  });
  it("bootstrap: media correcta y IC degenerado en datos constantes", () => {
    const c = bootstrapMean([0.5, 0.5, 0.5, 0.5]);
    assert.equal(c.mean, 0.5);
    assert.ok(c.lo === 0.5 && c.hi === 0.5);
    assert.ok(Number.isNaN(bootstrapMean([]).mean));
  });
});

describe("compuerta: walk-forward sin fuga", () => {
  it("cambiar resultados futuros no altera las predicciones anteriores", () => {
    const rows = simulate(3, "T1", "efficient");
    const a = walkForward(rows, { stepDays: 14 });
    const sorted = [...rows].sort((x, y) => x.kickoff.getTime() - y.kickoff.getTime());
    const cut = sorted[Math.floor(sorted.length * 0.8)]!.kickoff.getTime();
    const tampered = rows.map((x) => (x.kickoff.getTime() >= cut ? { ...x, hg: x.hg + 3, ag: 0 } : x));
    const b = walkForward(tampered, { stepDays: 14 });
    const before = (p: { kickoff: Date }) => p.kickoff.getTime() < cut - 14 * 86_400_000;
    const pa = a.filter(before);
    const pb = b.filter(before);
    assert.ok(pa.length > 300, `predicciones previas: ${pa.length}`);
    assert.equal(pa.length, pb.length);
    pa.forEach((p, i) => assert.deepEqual(p.raw, pb[i]!.raw));
  });
});

describe("compuerta: veredictos con mercados simulados", () => {
  it("si una casa blanda se equivoca de forma independiente, detecta utilidad (CLV > 0)", () => {
    const rows = [...simulate(11, "S1", "soft"), ...simulate(12, "S2", "soft")];
    const result = evaluate(walkForward(rows, { stepDays: 14 }));
    assert.ok(result.matches > 1500, `partidos: ${result.matches}`);
    assert.ok(result.scenarios.b365.baseline.bets > 150, `apuestas baseline: ${result.scenarios.b365.baseline.bets}`);
    assert.ok(result.scenarios.b365.baseline.clv.lo > 0, JSON.stringify(result.scenarios.b365.baseline.clv));
    // El referente (Pinnacle = verdad) no se puede batir: la mezcla no debe salir «mejor» que él.
    assert.notEqual(result.verdict, "ventaja demostrada", result.verdictReasons.join(" | "));
  });

  it("si el mercado es eficiente, el veredicto es «sin ventaja demostrada»", () => {
    const rows = [...simulate(21, "E1", "efficient"), ...simulate(22, "E2", "efficient")];
    const result = evaluate(walkForward(rows, { stepDays: 14 }));
    assert.equal(result.verdict, "sin ventaja demostrada", result.verdictReasons.join(" | "));
    const s = result.scenarios.b365.model;
    if (s.bets > 0) assert.ok(s.clv.mean < 0.01, `CLV medio ${s.clv.mean}`);
    assert.ok(result.quality.blendMinusBench.mean > -0.002, "no debe ganarle al referente que es la verdad");
  });
});
