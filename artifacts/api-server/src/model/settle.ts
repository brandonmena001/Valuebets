import { resultFor, type LineResult } from "./lines";
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

/**
 * Devuelve el resultado de la apuesta o null si todavía faltan datos para liquidar.
 * Con líneas enteras/de cuarto puede ser push (devuelto), half-win o half-loss.
 */
export function settleOutcome(input: SettleInput): LineResult | null {
  const key = input.selectionKey as SelectionKey;
  const { homeScore, awayScore, stats } = input;

  // Ambos anotan
  if (key === "yes" || key === "no") {
    const both = homeScore > 0 && awayScore > 0;
    return both === (key === "yes") ? "win" : "loss";
  }

  // Hándicap asiático: home/away con línea (la línea es el hándicap del local).
  if ((key === "home" || key === "away") && input.line != null) {
    return resultFor(homeScore - awayScore, -input.line, key === "home" ? 1 : -1);
  }

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
  if (key === "over") return resultFor(total, input.line, 1);
  if (key === "under") return resultFor(total, input.line, -1);
  return null;
}
