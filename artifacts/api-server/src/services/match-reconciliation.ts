import { and, eq, gte, inArray, lte, notInArray } from "drizzle-orm";
import {
  db,
  historicalResultsTable,
  matchesTable,
  matchStatsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { normalizeName, resolveName } from "../model/names";
import { apiFootballLeagues } from "./api-football";
import type { ParsedFixture } from "./football-data-parse";

const MATCH_RESULT_TOLERANCE_MS = 36 * 60 * 60 * 1000;
const STALE_MATCH_GRACE_MS = 36 * 60 * 60 * 1000;
const FIXTURE_MATCH_TOLERANCE_MS = 8 * 60 * 60 * 1000;
const FIXTURE_IMPORT_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

function normalizedTeamNames(names: Iterable<string>): string[] {
  return [...new Set([...names].map(normalizeName).filter(Boolean))];
}

/** Resolve both sides against one authoritative name list to avoid ambiguous aliases. */
export function teamsMatchToReference(
  home: string,
  away: string,
  referenceHome: string,
  referenceAway: string,
  knownNames: Iterable<string>,
): boolean {
  const known = normalizedTeamNames(knownNames);
  const resolvedHome = resolveName(home, known);
  const resolvedAway = resolveName(away, known);
  return (
    resolvedHome !== null &&
    resolvedAway !== null &&
    resolvedHome === normalizeName(referenceHome) &&
    resolvedAway === normalizeName(referenceAway)
  );
}

export async function reconcilePastMatches(now = new Date()): Promise<{
  scanned: number;
  finished: number;
  markedUnknown: number;
  statsAdded: number;
}> {
  const [matches, results] = await Promise.all([
    db
      .select()
      .from(matchesTable)
      .where(and(lte(matchesTable.kickoff, now), notInArray(matchesTable.status, ["cancelled"]))),
    db
      .select()
      .from(historicalResultsTable)
      .where(lte(historicalResultsTable.kickoff, now)),
  ]);

  if (!matches.length) {
    return { scanned: 0, finished: 0, markedUnknown: 0, statsAdded: 0 };
  }

  const resultsByLeague = new Map<string, typeof results>();
  const namesByLeague = new Map<string, string[]>();
  for (const result of results) {
    resultsByLeague.set(result.leagueCode, [
      ...(resultsByLeague.get(result.leagueCode) ?? []),
      result,
    ]);
    namesByLeague.set(result.leagueCode, [
      ...(namesByLeague.get(result.leagueCode) ?? []),
      result.homeTeam,
      result.awayTeam,
    ]);
  }

  const statsRows = await db
    .select({ matchId: matchStatsTable.matchId })
    .from(matchStatsTable)
    .where(inArray(matchStatsTable.matchId, matches.map((match) => match.id)));
  const matchesWithStats = new Set(statsRows.map((row) => row.matchId));
  let finished = 0;
  let markedUnknown = 0;
  let statsAdded = 0;

  for (const match of matches) {
    const leagueResults = resultsByLeague.get(match.leagueCode) ?? [];
    const knownNames = namesByLeague.get(match.leagueCode) ?? [];
    const result = leagueResults
      .filter(
        (candidate) =>
          Math.abs(candidate.kickoff.getTime() - match.kickoff.getTime()) <=
          MATCH_RESULT_TOLERANCE_MS,
      )
      .filter((candidate) =>
        teamsMatchToReference(
          match.homeTeam,
          match.awayTeam,
          candidate.homeTeam,
          candidate.awayTeam,
          knownNames,
        ),
      )
      .sort(
        (left, right) =>
          Math.abs(left.kickoff.getTime() - match.kickoff.getTime()) -
          Math.abs(right.kickoff.getTime() - match.kickoff.getTime()),
      )[0];

    if (result) {
      if (
        match.status !== "finished" ||
        match.homeScore !== result.homeScore ||
        match.awayScore !== result.awayScore
      ) {
        await db
          .update(matchesTable)
          .set({
            status: "finished",
            homeScore: result.homeScore,
            awayScore: result.awayScore,
            updatedAt: now,
          })
          .where(eq(matchesTable.id, match.id));
        finished += 1;
      }

      if (!matchesWithStats.has(match.id)) {
        await db
          .insert(matchStatsTable)
          .values({
            matchId: match.id,
            homeCorners: result.homeCorners,
            awayCorners: result.awayCorners,
            homeYellowCards: result.homeYellowCards,
            awayYellowCards: result.awayYellowCards,
            homeRedCards: result.homeRedCards,
            awayRedCards: result.awayRedCards,
            homeShotsOnTarget: result.homeShotsOnTarget,
            awayShotsOnTarget: result.awayShotsOnTarget,
            source: "football-data",
            updatedAt: now,
          })
          .onConflictDoNothing();
        matchesWithStats.add(match.id);
        statsAdded += 1;
      }
      continue;
    }

    const olderThanGrace =
      match.kickoff.getTime() < now.getTime() - STALE_MATCH_GRACE_MS;
    if (olderThanGrace && ["scheduled", "live"].includes(match.status)) {
      await db
        .update(matchesTable)
        .set({ status: "unknown", updatedAt: now })
        .where(eq(matchesTable.id, match.id));
      markedUnknown += 1;
    }
  }

  return { scanned: matches.length, finished, markedUnknown, statsAdded };
}

export async function syncFootballDataFixtures(
  fixtures: ParsedFixture[],
  now = new Date(),
): Promise<{ considered: number; inserted: number; updated: number }> {
  const leagueByCode = new Map<
    string,
    (typeof apiFootballLeagues)[number]
  >();
  for (const league of apiFootballLeagues) {
    leagueByCode.set(league.code, league);
  }
  const eligible = fixtures.filter(
    (fixture) =>
      leagueByCode.has(fixture.leagueCode) &&
      fixture.kickoff.getTime() > now.getTime() &&
      fixture.kickoff.getTime() <= now.getTime() + FIXTURE_IMPORT_HORIZON_MS,
  );
  if (!eligible.length) {
    return { considered: 0, inserted: 0, updated: 0 };
  }

  const leagueCodes = [...new Set(eligible.map((fixture) => fixture.leagueCode))];
  const existing = await db
    .select()
    .from(matchesTable)
    .where(
      and(
        inArray(matchesTable.leagueCode, leagueCodes),
        gte(matchesTable.kickoff, new Date(now.getTime() - FIXTURE_MATCH_TOLERANCE_MS)),
        lte(
          matchesTable.kickoff,
          new Date(now.getTime() + FIXTURE_IMPORT_HORIZON_MS),
        ),
      ),
    );
  const knownNamesByLeague = new Map<string, string[]>();
  for (const match of existing) {
    knownNamesByLeague.set(match.leagueCode, [
      ...(knownNamesByLeague.get(match.leagueCode) ?? []),
      match.homeTeam,
      match.awayTeam,
    ]);
  }

  let inserted = 0;
  let updated = 0;
  for (const fixture of eligible) {
    const league = leagueByCode.get(fixture.leagueCode)!;
    const leagueMatches = existing.filter(
      (match) => match.leagueCode === fixture.leagueCode,
    );
    const knownNames = knownNamesByLeague.get(fixture.leagueCode) ?? [];
    const matched = leagueMatches
      .filter(
        (match) =>
          Math.abs(match.kickoff.getTime() - fixture.kickoff.getTime()) <=
          FIXTURE_MATCH_TOLERANCE_MS,
      )
      .find((match) =>
        teamsMatchToReference(
          fixture.homeTeam,
          fixture.awayTeam,
          match.homeTeam,
          match.awayTeam,
          knownNames,
        ),
      );

    if (matched) {
      if (["finished", "cancelled"].includes(matched.status)) continue;
      const needsUpdate =
        Math.abs(matched.kickoff.getTime() - fixture.kickoff.getTime()) > 60_000 ||
        matched.status !== "scheduled";
      if (needsUpdate) {
        await db
          .update(matchesTable)
          .set({
            kickoff: fixture.kickoff,
            status: "scheduled",
            updatedAt: now,
          })
          .where(eq(matchesTable.id, matched.id));
        matched.kickoff = fixture.kickoff;
        matched.status = "scheduled";
        updated += 1;
      }
      continue;
    }

    const [saved] = await db
      .insert(matchesTable)
      .values({
        apiFootballFixtureId: null,
        oddsPapiFixtureId: null,
        leagueCode: fixture.leagueCode,
        leagueName: league.name,
        country: league.country,
        homeTeamApiId: null,
        awayTeamApiId: null,
        homeTeam: fixture.homeTeam,
        awayTeam: fixture.awayTeam,
        kickoff: fixture.kickoff,
        status: "scheduled",
        homeScore: null,
        awayScore: null,
        updatedAt: now,
      })
      .returning();
    existing.push(saved!);
    knownNamesByLeague.set(fixture.leagueCode, [
      ...knownNames,
      fixture.homeTeam,
      fixture.awayTeam,
    ]);
    inserted += 1;
  }

  return { considered: eligible.length, inserted, updated };
}
