import { normalizeName } from "./names";

export type StatKey = "goals" | "corners" | "cards" | "sot";
export type SelectionKey = "home" | "draw" | "away" | "over" | "under";
export type QuoteKind = "result" | "total" | "player";

export type QuoteForClassification = {
  marketCategory: string;
  marketName: string;
  selection: string;
  playerName: string | null;
  line: number | null;
  upstreamMarketId: string | null;
};

export type ClassifiedQuote = {
  kind: QuoteKind;
  stat: StatKey;
  selectionKey: SelectionKey;
  line: number | null;
  /** Identifica el mercado dentro de una casa (para agrupar selecciones y quitar el margen). */
  marketKey: string;
  /** Identifica el mercado entre casas (para el consenso). */
  consensusKey: string;
};

// El clasificador del colector es amplio: "goals" incluye mercados de 1ª parte, de
// equipo, hándicaps, etc. Tratarlos como totales del partido genera value bets falsas.
const COMMON_BLOCK =
  /\b(1st|2nd|first|second|half|1h|2h|extra time|overtime|penalt\w*|interval|minutes?|period|exact|odd|even|range|race|combo|both|btts|handicap|asian|double chance|draw no bet|clean sheet|without|anytime|last|points|margin|multi|to win|to score)\b/;
const TOTAL_BLOCK = /\b(team|home|away|each|either|player|any)\b/;
const RESULT_BLOCK = /\b(corner\w*|card\w*|booking\w*|shot\w*|goal\w*|total)\b/;

function isHalfLine(line: number): boolean {
  return Math.abs(line - Math.round(line)) > 0.05;
}

function overUnder(selection: string): "over" | "under" | null {
  const text = normalizeName(selection);
  if (/\b(over|more|mas|mayor)\b/.test(text)) return "over";
  if (/\b(under|less|menos|menor)\b/.test(text)) return "under";
  return null;
}

function resultKey(selection: string, home: string, away: string): SelectionKey | null {
  const pick = normalizeName(selection);
  const h = normalizeName(home);
  const a = normalizeName(away);
  if (pick === "1" || pick === "home" || pick === h) return "home";
  if (pick === "2" || pick === "away" || pick === a) return "away";
  if (["x", "draw", "tie", "empate"].includes(pick)) return "draw";
  const hasHome = pick.includes(h);
  const hasAway = pick.includes(a);
  if (hasHome && !hasAway) return "home";
  if (hasAway && !hasHome) return "away";
  return null;
}

/** Devuelve null si el mercado no es uno que el modelo sepa valorar con rigor. */
export function classifyQuote(
  quote: QuoteForClassification,
  match: { homeTeam: string; awayTeam: string },
): ClassifiedQuote | null {
  const name = normalizeName(quote.marketName);
  if (COMMON_BLOCK.test(name)) return null;
  const marketId = quote.upstreamMarketId ?? name;

  if (quote.marketCategory === "match-result") {
    if (RESULT_BLOCK.test(name) || quote.playerName) return null;
    const selectionKey = resultKey(quote.selection, match.homeTeam, match.awayTeam);
    if (!selectionKey || selectionKey === "over" || selectionKey === "under") return null;
    return {
      kind: "result",
      stat: "goals",
      selectionKey,
      line: null,
      marketKey: `${marketId}`,
      consensusKey: "result",
    };
  }

  const stat: StatKey | null =
    quote.marketCategory === "goals" ? "goals"
    : quote.marketCategory === "corners" ? "corners"
    : quote.marketCategory === "cards" ? "cards"
    : quote.marketCategory === "shots-on-target" ? "sot"
    : null;
  if (!stat) return null;

  const selectionKey = overUnder(quote.selection);
  if (!selectionKey || quote.line == null || !isHalfLine(quote.line)) return null;

  if (quote.playerName) {
    if (stat !== "sot") return null;
    const player = normalizeName(quote.playerName);
    return {
      kind: "player",
      stat,
      selectionKey,
      line: quote.line,
      marketKey: `${marketId}|${quote.line}|${player}`,
      consensusKey: `player|${player}|${quote.line}`,
    };
  }

  if (TOTAL_BLOCK.test(name)) return null;
  return {
    kind: "total",
    stat,
    selectionKey,
    line: quote.line,
    marketKey: `${marketId}|${quote.line}`,
    consensusKey: `total|${stat}|${quote.line}`,
  };
}

export function expectedKeys(kind: QuoteKind): SelectionKey[] {
  return kind === "result" ? ["home", "draw", "away"] : ["over", "under"];
}
