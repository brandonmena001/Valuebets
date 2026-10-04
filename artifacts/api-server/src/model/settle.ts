import type { SelectionKey } from "./markets";

export type SettleInput = {
  marketCategory: string;
  selectionKey: string;
  line: number | null;
  playerName: string | null;
  homeScore: number;
  awayScore: number;
  stats: {
    homeCorners: number | null;
    awayCorners: number | null;
    homeYellowCards: number | null;
    awayYellowCards: number | null;
    homeRedCards: number | null;
    awayRedCards: number | null;
    homeShotsOnTarget: number | null;
    awayShotsOnTarget: number | null;
  } | null;
  /** Tiros a puerta del jugador en ese partido (null = sin dato). */
  playerShots: number | null;
};

/** Devuelve win/loss o null si todavía faltan datos para liquidar. */
export function settleOutcome(input: SettleInput): "win" | "loss" | null {
  const key = input.selectionKey as SelectionKey;
  const { homeScore, awayScore, stats } = input;

  if (input.marketCategory === "match-result") {
    const actual = homeScore > awayScore ? "home" : homeScore < awayScore ? "away" : "draw";
    return actual === key ? "win" : "loss";
  }

  let total: number | null = null;
  if (input.marketCategory === "goals") {
    total = homeScore + awayScore;
  } else if (input.marketCategory === "corners") {
    if (stats?.homeCorners == null || stats.awayCorners == null) return null;
    total = stats.homeCorners + stats.awayCorners;
  } else if (input.marketCategory === "cards") {
    if (stats?.homeYellowCards == null || stats.awayYellowCards == null) return null;
    total =
      stats.homeYellowCards + stats.awayYellowCards +
      (stats.homeRedCards ?? 0) + (stats.awayRedCards ?? 0);
  } else if (input.marketCategory === "shots-on-target") {
    if (input.playerName) {
      total = input.playerShots;
    } else {
      if (stats?.homeShotsOnTarget == null || stats.awayShotsOnTarget == null) return null;
      total = stats.homeShotsOnTarget + stats.awayShotsOnTarget;
    }
  }
  if (total == null || input.line == null) return null;
  if (key === "over") return total > input.line ? "win" : "loss";
  if (key === "under") return total < input.line ? "win" : "loss";
  return null;
}
