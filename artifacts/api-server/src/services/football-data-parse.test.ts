import assert from "node:assert/strict";
import { test } from "node:test";
import { currentSeasonStartYear, parseCsv, parseFootballDataCsv, parseFootballDataFixtures, seasonCode } from "./football-data-parse";

// Extractos REALES de football-data.co.uk (temporada 2025/26), recortados a las columnas Div..AR
// (las de cuotas se omiten; el parser lee por nombre). Muestras aportadas por el usuario.
const E0 = [
  "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,Referee,HS,AS,HST,AST,HF,AF,HC,AC,HY,AY,HR,AR,B365H,B365D,B365A",
  "E0,15/08/2025,20:00,Liverpool,Bournemouth,4,2,H,1,0,H,A Taylor,19,10,10,3,7,10,6,7,1,2,0,0,1.3,6,8.5",
  "E0,16/08/2025,12:30,Aston Villa,Newcastle,0,0,D,0,0,D,C Pawson,3,16,3,3,13,11,3,6,1,1,1,0,2.25,3.5,2.9",
].join("\r\n");
const SP1 = [
  "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,HS,AS,HST,AST,HF,AF,HC,AC,HY,AY,HR,AR,B365H,B365D,B365A",
  "SP1,15/08/2025,18:00,Girona,Vallecano,1,3,A,0,3,A,7,16,2,5,8,17,2,4,0,1,1,0,2.25,3.25,3.3",
  "SP1,16/08/2025,18:30,Mallorca,Barcelona,0,3,A,0,2,A,4,24,1,8,8,17,3,6,4,1,2,0,7,5,1.4",
].join("\n");
const D1 = [
  "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,HS,AS,HST,AST,HF,AF,HC,AC,HY,AY,HR,AR,B365H,B365D,B365A",
  "D1,22/08/2025,19:30,Bayern Munich,RB Leipzig,6,0,H,3,0,H,19,12,10,1,13,13,5,5,4,1,0,0,1.22,7,9",
  "D1,23/08/2025,14:30,Ein Frankfurt,Werder Bremen,4,1,H,2,0,H,18,10,5,5,9,9,7,1,1,3,0,0,1.7,4.1,4.5",
].join("\n");

test("E0: columnas por nombre (con Referee) y hora UK->UTC en verano", () => {
  const [a, b] = parseFootballDataCsv(E0, "premier-league", "2526");
  assert.equal(a!.homeTeam, "Liverpool");
  assert.equal(a!.kickoff.toISOString(), "2025-08-15T19:00:00.000Z");
  assert.equal(a!.matchKey, "2025-08-15|Liverpool|Bournemouth");
  assert.deepEqual(
    [a!.homeScore, a!.awayScore, a!.homeCorners, a!.awayCorners, a!.homeYellowCards, a!.awayYellowCards, a!.homeRedCards, a!.awayRedCards, a!.homeShotsOnTarget, a!.awayShotsOnTarget],
    [4, 2, 6, 7, 1, 2, 0, 0, 10, 3],
  );
  assert.equal(b!.homeRedCards, 1);
  assert.equal(b!.awayCorners, 6);
  assert.equal(b!.kickoff.toISOString(), "2025-08-16T11:30:00.000Z");
});

test("SP1: sin columna Referee, mismas estadísticas", () => {
  const [a, b] = parseFootballDataCsv(SP1, "la-liga", "2526");
  assert.equal(a!.awayTeam, "Vallecano");
  assert.equal(a!.kickoff.toISOString(), "2025-08-15T17:00:00.000Z");
  assert.deepEqual([a!.homeShotsOnTarget, a!.awayShotsOnTarget, a!.homeCorners, a!.awayCorners, a!.awayYellowCards, a!.homeRedCards], [2, 5, 2, 4, 1, 1]);
  assert.deepEqual([b!.homeScore, b!.awayScore, b!.homeYellowCards, b!.awayRedCards], [0, 3, 4, 0]);
});

test("D1: nombres tal como los publica football-data", () => {
  const rows = parseFootballDataCsv(D1, "bundesliga", "2526");
  assert.deepEqual(rows.map((r) => `${r.homeTeam} - ${r.awayTeam}`), ["Bayern Munich - RB Leipzig", "Ein Frankfurt - Werder Bremen"]);
  assert.deepEqual([rows[0]!.homeShotsOnTarget, rows[0]!.awayShotsOnTarget, rows[0]!.homeYellowCards], [10, 1, 4]);
  assert.equal(rows[1]!.kickoff.toISOString(), "2025-08-23T13:30:00.000Z");
});

test("omite partidos sin marcador (futuros), filas vacías y acepta BOM", () => {
  const csv = "\uFEFF" + E0 + "\r\nE0,01/05/2026,15:00,Everton,Fulham,,,,,,,,,,,,,,,,,,,,,,\r\n\r\n";
  assert.equal(parseFootballDataCsv(csv, "premier-league", "2526").length, 2);
});

test("fecha con año de 2 dígitos, sin Time y cambio de hora de invierno (GMT)", () => {
  const csv = "Date,HomeTeam,AwayTeam,FTHG,FTAG\n05/12/24,A,B,1,0\n";
  const [r] = parseFootballDataCsv(csv, "x", "2425");
  assert.equal(r!.kickoff.toISOString(), "2024-12-05T15:00:00.000Z");
  assert.equal(r!.homeCorners, null);
});

test("encabezado desconocido devuelve vacío; parseCsv respeta comillas", () => {
  assert.deepEqual(parseFootballDataCsv("a,b\n1,2", "x", "y"), []);
  assert.deepEqual(parseCsv('a,"b,c"\n"d""e",f'), [["a", "b,c"], ['d"e', "f"]]);
});

test("códigos de temporada", () => {
  assert.equal(seasonCode(2025), "2526");
  assert.equal(seasonCode(2026), "2627");
  assert.equal(currentSeasonStartYear(new Date("2026-10-10T00:00:00Z")), 2026);
  assert.equal(currentSeasonStartYear(new Date("2026-03-01T00:00:00Z")), 2025);
});

// Extracto REAL de la temporada 2026/27 (E0 trae columnas nuevas HxG y AxG).
const E0_2627 = [
  "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,Referee,HxG,AxG,HS,AS,HST,AST,HF,AF,HC,AC,HY,AY,HR,AR,B365H,B365D,B365A",
  "E0,21/08/2026,20:00,Arsenal,Coventry,3,0,H,2,0,H,T Bramall,1.88,0.2,20,4,6,1,10,13,8,2,1,1,0,0,1.2,7,13",
  "E0,22/08/2026,12:30,Hull,Man United,2,0,H,2,0,H,D England,1.01,1.83,8,21,4,5,10,9,1,6,2,1,0,0,8.5,5,1.36",
].join("\r\n");

test("E0 2026/27: las columnas HxG/AxG no desplazan las estadísticas", () => {
  const [a, b] = parseFootballDataCsv(E0_2627, "premier-league", "2627");
  assert.equal(a!.kickoff.toISOString(), "2026-08-21T19:00:00.000Z");
  assert.deepEqual([a!.homeShotsOnTarget, a!.awayShotsOnTarget, a!.homeCorners, a!.awayCorners, a!.homeYellowCards, a!.awayYellowCards], [6, 1, 8, 2, 1, 1]);
  assert.equal(b!.awayTeam, "Man United");
  assert.deepEqual([b!.homeShotsOnTarget, b!.awayShotsOnTarget, b!.homeCorners, b!.awayCorners, b!.homeYellowCards, b!.awayYellowCards], [4, 5, 1, 6, 2, 1]);
});

// Extracto REAL de fixtures.csv (liga belga B1; sin marcador y con Referee vacío).
const FIXTURES = [
  "Div,Date,Time,HomeTeam,AwayTeam,Referee,B365H,B365D,B365A,BFDH",
  "B1,09/10/2026,19:45,Beveren,Lommel SK,,1.75,3.8,3.9,1.8",
  "B1,10/10/2026,17:15,RAAL La Louviere,Club Brugge,,6.25,4.33,1.42,7",
  "E0,17/10/2026,15:00,Everton,Fulham,,,,,",
].join("\r\n");

test("fixtures.csv: filtra por Div, hora UK->UTC y cuotas opcionales", () => {
  const all = parseFootballDataFixtures(FIXTURES, { B1: "belgica", E0: "premier-league" });
  assert.equal(all.length, 3);
  assert.equal(all[0]!.kickoff.toISOString(), "2026-10-09T18:45:00.000Z");
  assert.deepEqual([all[0]!.homeOdds, all[0]!.drawOdds, all[0]!.awayOdds], [1.75, 3.8, 3.9]);
  assert.deepEqual([all[2]!.homeOdds, all[2]!.awayOdds], [null, null]);
  const onlyEngland = parseFootballDataFixtures(FIXTURES, { E0: "premier-league" });
  assert.deepEqual(onlyEngland.map((f) => f.homeTeam), ["Everton"]);
  assert.deepEqual(parseFootballDataFixtures("x,y\n1,2", { E0: "a" }), []);
});
