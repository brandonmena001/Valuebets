export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const STOP_TOKENS = new Set([
  "fc", "cf", "afc", "sc", "ac", "ssc", "rcd", "ud", "cd", "sv", "vfb", "vfl",
  "fsv", "tsg", "bsc", "fk", "club", "1", "04", "05", "96", "1899", "1846",
  "1900", "1907", "de", "calcio",
]);

const ALIASES: Record<string, string> = {
  utd: "united", spurs: "tottenham", wolves: "wolverhampton", nottm: "nottingham",
  munchen: "munich", koln: "cologne", atl: "atletico", ath: "athletic",
  gladbach: "monchengladbach", leverkusen: "leverkusen", inter: "internazionale",
};

function tokens(value: string): string[] {
  return normalizeName(value)
    .split(" ")
    .filter((token) => token && !STOP_TOKENS.has(token))
    .map((token) => ALIASES[token] ?? token);
}

function tokenMatches(short: string, long: string): boolean {
  return short === long || (short.length >= 3 && long.startsWith(short));
}

function listMatches(shorter: string[], longer: string[]): boolean {
  if (!shorter.length) return false;
  if (shorter.length === 1 && shorter[0]!.length < 4) return false;
  return shorter.every((token) => longer.some((other) => tokenMatches(token, other)));
}

/**
 * Las cuotas (OddsPapi) y el histórico (API-Football) pueden nombrar distinto al
 * mismo equipo ("Man City" / "Manchester City"). Devuelve la clave del histórico
 * solo si la coincidencia es única; si hay ambigüedad devuelve null y el modelo
 * se abstiene en vez de adivinar.
 */
export function resolveName(name: string, known: Iterable<string>): string | null {
  const normalized = normalizeName(name);
  const knownList = [...known];
  if (knownList.includes(normalized)) return normalized;
  const wanted = tokens(name);
  const matches = knownList.filter((candidate) => {
    const other = tokens(candidate);
    return wanted.length <= other.length
      ? listMatches(wanted, other)
      : listMatches(other, wanted);
  });
  return matches.length === 1 ? matches[0]! : null;
}
