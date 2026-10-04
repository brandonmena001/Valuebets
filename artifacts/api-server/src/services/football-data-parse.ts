export type ParsedResult = {
  leagueCode: string;
  season: string;
  matchKey: string;
  kickoff: Date;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  homeCorners: number | null;
  awayCorners: number | null;
  homeYellowCards: number | null;
  awayYellowCards: number | null;
  homeRedCards: number | null;
  awayRedCards: number | null;
  homeShotsOnTarget: number | null;
  awayShotsOnTarget: number | null;
};

/** CSV mínimo: BOM, comillas, saltos CRLF y campos vacíos. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function lastSunday(year: number, monthIndex: number): number {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  return last.getUTCDate() - last.getUTCDay();
}

/** football-data publica la hora en horario del Reino Unido (GMT/BST). */
function ukToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const bstStart = Date.UTC(year, 2, lastSunday(year, 2), 1);
  const bstEnd = Date.UTC(year, 9, lastSunday(year, 9), 1);
  const offsetHours = naive >= bstStart + 3_600_000 && naive < bstEnd ? 1 : 0;
  return new Date(naive - offsetHours * 3_600_000);
}

function parseDate(dateText: string, timeText: string): Date | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(dateText.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  const time = /^(\d{1,2}):(\d{2})/.exec(timeText.trim());
  const date = ukToUtc(year, month, day, time ? Number(time[1]) : 15, time ? Number(time[2]) : 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function int(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Convierte un CSV de football-data.co.uk (E0, SP1, D1...) en resultados terminados.
 * Se leen las columnas por nombre; las estadísticas que falten quedan en null.
 */
export function parseFootballDataCsv(text: string, leagueCode: string, season: string): ParsedResult[] {
  const rows = parseCsv(text);
  const header = rows[0]?.map((name) => name.trim());
  if (!header) return [];
  const col = (name: string) => header.indexOf(name);
  const idx = {
    date: col("Date"), time: col("Time"), home: col("HomeTeam"), away: col("AwayTeam"),
    fthg: col("FTHG"), ftag: col("FTAG"), hc: col("HC"), ac: col("AC"), hy: col("HY"), ay: col("AY"),
    hr: col("HR"), ar: col("AR"), hst: col("HST"), ast: col("AST"),
  };
  if (idx.date < 0 || idx.home < 0 || idx.away < 0 || idx.fthg < 0 || idx.ftag < 0) return [];
  const results: ParsedResult[] = [];
  for (const row of rows.slice(1)) {
    const homeTeam = row[idx.home]?.trim();
    const awayTeam = row[idx.away]?.trim();
    const homeScore = int(row[idx.fthg]);
    const awayScore = int(row[idx.ftag]);
    const kickoff = parseDate(row[idx.date] ?? "", idx.time >= 0 ? row[idx.time] ?? "" : "");
    if (!homeTeam || !awayTeam || homeScore == null || awayScore == null || !kickoff) continue;
    const get = (i: number) => (i >= 0 ? int(row[i]) : null);
    results.push({
      leagueCode, season,
      matchKey: `${kickoff.toISOString().slice(0, 10)}|${homeTeam}|${awayTeam}`,
      kickoff, homeTeam, awayTeam, homeScore, awayScore,
      homeCorners: get(idx.hc), awayCorners: get(idx.ac),
      homeYellowCards: get(idx.hy), awayYellowCards: get(idx.ay),
      homeRedCards: get(idx.hr), awayRedCards: get(idx.ar),
      homeShotsOnTarget: get(idx.hst), awayShotsOnTarget: get(idx.ast),
    });
  }
  return results;
}

/** Código de temporada de football-data: 2026/27 -> "2627". */
export function seasonCode(startYear: number): string {
  const yy = (year: number) => String(year % 100).padStart(2, "0");
  return `${yy(startYear)}${yy(startYear + 1)}`;
}

export function currentSeasonStartYear(now = new Date()): number {
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}
