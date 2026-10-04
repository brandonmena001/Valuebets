import { ESS_HALF_WEIGHT, MODEL_VERSION, maxModelWeight, modelConfig } from "./config";
import { clamp, devigPower, median, negBinPmf, overProbability, sum } from "./math";
import { classifyQuote, expectedKeys, type ClassifiedQuote, type SelectionKey, type StatKey } from "./markets";
import { normalizeName, resolveName } from "./names";
import {
  expectedRates, fitRateModel, resultProbs, scoreMatrix, totalCountPmf, totalGoalsPmf,
  type Obs, type RateModel,
} from "./strength";

export type HistoryMatch = {
  id: number;
  leagueCode: string;
  homeTeam: string;
  awayTeam: string;
  kickoff: Date;
  homeScore: number | null;
  awayScore: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  homeYellowCards: number | null;
  awayYellowCards: number | null;
  homeRedCards: number | null;
  awayRedCards: number | null;
  homeShotsOnTarget: number | null;
  awayShotsOnTarget: number | null;
};

export type UpcomingMatch = {
  id: number;
  leagueCode: string;
  homeTeam: string;
  awayTeam: string;
  kickoff: Date;
};

export type QuoteInput = {
  id: number;
  matchId: number;
  bookmaker: string;
  upstreamMarketId: string | null;
  marketCategory: string;
  marketName: string;
  selection: string;
  playerName: string | null;
  line: number | null;
  decimalOdds: number;
  capturedAt: Date;
  sourceUpdatedAt: Date | null;
};

export type PlayerGame = {
  playerName: string;
  kickoff: Date;
  minutes: number | null;
  shots: number | null;
};

export type PredictionOutput = {
  oddsQuoteId: number;
  matchId: number;
  marketCategory: string;
  marketName: string;
  selection: string;
  selectionKey: SelectionKey;
  line: number | null;
  playerName: string | null;
  bookmaker: string;
  decimalOdds: number;
  rawModelProbability: number;
  marketProbability: number;
  modelProbability: number;
  fairOdds: number;
  expectedValuePct: number;
  kellyFraction: number;
  bookmakersCount: number;
  sampleSize: number;
  confidence: "low" | "medium" | "high";
  modelVersion: string;
};

const DAY_MS = 86_400_000;

function decay(now: Date, when: Date, halfLifeDays: number): number {
  const age = Math.max(0, (now.getTime() - when.getTime()) / DAY_MS);
  return Math.exp((-Math.LN2 * age) / halfLifeDays);
}

function statValues(row: HistoryMatch, stat: StatKey): [number, number] | null {
  if (stat === "goals") {
    return row.homeScore == null || row.awayScore == null ? null : [row.homeScore, row.awayScore];
  }
  if (stat === "corners") {
    return row.homeCorners == null || row.awayCorners == null ? null : [row.homeCorners, row.awayCorners];
  }
  if (stat === "sot") {
    return row.homeShotsOnTarget == null || row.awayShotsOnTarget == null
      ? null
      : [row.homeShotsOnTarget, row.awayShotsOnTarget];
  }
  if (row.homeYellowCards == null || row.awayYellowCards == null) return null;
  return [
    row.homeYellowCards + (row.homeRedCards ?? 0),
    row.awayYellowCards + (row.awayRedCards ?? 0),
  ];
}

type LeagueModel = { model: RateModel; teams: string[] };

type MatchDistribution = {
  ess: Partial<Record<StatKey, number>>;
  result?: { home: number; draw: number; away: number };
  total: Record<StatKey, number[] | undefined>;
};

type PlayerModel = { pmf: number[]; sampleSize: number };

export function fitLeagueModel(
  history: HistoryMatch[],
  league: string,
  stat: StatKey,
  now: Date,
): LeagueModel | null {
  const cfg = modelConfig;
  const obs: Obs[] = [];
  for (const row of history) {
    if (row.leagueCode !== league || row.kickoff >= now) continue;
    const values = statValues(row, stat);
    if (!values) continue;
    const w = decay(now, row.kickoff, cfg.halfLifeDays);
    if (w < 1e-3) continue;
    obs.push({
      home: normalizeName(row.homeTeam),
      away: normalizeName(row.awayTeam),
      hv: values[0],
      av: values[1],
      w,
    });
  }
  const fitted =
    obs.length >= cfg.minLeagueMatches
      ? fitRateModel(obs, cfg.priorGames, { goals: stat === "goals" })
      : null;
  return fitted ? { model: fitted, teams: [...fitted.att.keys()] } : null;
}

export type LineProbability = { line: number; over: number };
export type MatchSnapshot = {
  modelVersion: string;
  expectedGoals: { home: number; away: number };
  result: { home: number; draw: number; away: number };
  btts: number;
  topScores: Array<{ home: number; away: number; probability: number }>;
  goalLines: LineProbability[];
  teamStats: Array<{
    stat: "corners" | "cards" | "shots-on-target";
    homeExpected: number;
    awayExpected: number;
    totalExpected: number;
    lines: LineProbability[];
  }>;
  dataQuality: { score: number; level: "low" | "medium" | "high"; homeSample: number; awaySample: number };
};

function linesAround(mean: number, pmf: number[], count: number): LineProbability[] {
  const first = Math.max(0.5, Math.floor(mean) - Math.floor(count / 2) + 0.5);
  return Array.from({ length: count }, (_, i) => {
    const line = first + i;
    return { line, over: overProbability(pmf, line) };
  });
}

/**
 * Lectura del modelo puro para una ficha de partido (sin mezclar con el mercado).
 * Devuelve null si faltan datos suficientes de alguno de los equipos.
 */
export function buildMatchSnapshot(input: {
  history: HistoryMatch[];
  match: { leagueCode: string; homeTeam: string; awayTeam: string };
  now: Date;
}): MatchSnapshot | null {
  const { history, match, now } = input;
  const goals = fitLeagueModel(history, match.leagueCode, "goals", now);
  if (!goals) return null;
  const home = resolveName(match.homeTeam, goals.teams);
  const away = resolveName(match.awayTeam, goals.teams);
  if (!home || !away) return null;
  const rates = expectedRates(goals.model, home, away);
  if (!rates || rates.ess < modelConfig.minTeamEss) return null;

  const matrix = scoreMatrix(rates.lh, rates.la, goals.model.rho);
  const scores: Array<{ home: number; away: number; probability: number }> = [];
  for (let i = 0; i < matrix.length; i += 1) {
    for (let j = 0; j < matrix[i]!.length; j += 1) scores.push({ home: i, away: j, probability: matrix[i]![j]! });
  }
  scores.sort((a, b) => b.probability - a.probability);
  const pAway0 = sum(matrix.map((row) => row[0] ?? 0));
  const pHome0 = sum(matrix[0] ?? []);
  const btts = clamp(1 - pHome0 - pAway0 + (matrix[0]?.[0] ?? 0), 0, 1);
  const goalsPmf = totalGoalsPmf(matrix);

  const teamStats: MatchSnapshot["teamStats"] = [];
  for (const [stat, key] of [["corners", "corners"], ["cards", "cards"], ["sot", "shots-on-target"]] as const) {
    const lm = fitLeagueModel(history, match.leagueCode, stat, now);
    if (!lm) continue;
    const h = resolveName(match.homeTeam, lm.teams);
    const a = resolveName(match.awayTeam, lm.teams);
    if (!h || !a) continue;
    const r = expectedRates(lm.model, h, a);
    if (!r || r.ess < modelConfig.minTeamEss) continue;
    const pmf = totalCountPmf(r.lh, r.la, lm.model.alpha);
    teamStats.push({
      stat: key,
      homeExpected: r.lh,
      awayExpected: r.la,
      totalExpected: r.lh + r.la,
      lines: linesAround(r.lh + r.la, pmf, 6),
    });
  }

  const score = Math.round(100 * (1 - Math.exp(-rates.ess / 12)));
  return {
    modelVersion: MODEL_VERSION,
    expectedGoals: { home: rates.lh, away: rates.la },
    result: resultProbs(matrix),
    btts,
    topScores: scores.slice(0, 6),
    goalLines: [0.5, 1.5, 2.5, 3.5, 4.5].map((line) => ({ line, over: overProbability(goalsPmf, line) })),
    teamStats,
    dataQuality: {
      score,
      level: score >= 75 ? "high" : score >= 50 ? "medium" : "low",
      homeSample: goals.model.ess.get(home) ?? 0,
      awaySample: goals.model.ess.get(away) ?? 0,
    },
  };
}

export function buildPredictions(input: {
  history: HistoryMatch[];
  playerGames: PlayerGame[];
  matches: UpcomingMatch[];
  quotes: QuoteInput[];
  now: Date;
}): PredictionOutput[] {
  const { now } = input;
  const cfg = modelConfig;
  const leagueModels = new Map<string, LeagueModel | null>();

  const leagueModel = (league: string, stat: StatKey): LeagueModel | null => {
    const key = `${league}|${stat}`;
    if (leagueModels.has(key)) return leagueModels.get(key) ?? null;
    const result = fitLeagueModel(input.history, league, stat, now);
    leagueModels.set(key, result);
    return result;
  };

  const distributionCache = new Map<number, MatchDistribution | null>();
  const distribution = (match: UpcomingMatch, stats: Set<StatKey>): MatchDistribution => {
    let dist = distributionCache.get(match.id);
    if (!dist) {
      dist = { ess: {}, total: { goals: undefined, corners: undefined, cards: undefined, sot: undefined } };
      distributionCache.set(match.id, dist);
    }
    for (const stat of stats) {
      if (dist.total[stat]) continue;
      const lm = leagueModel(match.leagueCode, stat);
      if (!lm) continue;
      const home = resolveName(match.homeTeam, lm.teams);
      const away = resolveName(match.awayTeam, lm.teams);
      if (!home || !away) continue;
      const rates = expectedRates(lm.model, home, away);
      if (!rates || rates.ess < cfg.minTeamEss) continue;
      if (stat === "goals") {
        const matrix = scoreMatrix(rates.lh, rates.la, lm.model.rho);
        dist.result = resultProbs(matrix);
        dist.total.goals = totalGoalsPmf(matrix);
      } else {
        dist.total[stat] = totalCountPmf(rates.lh, rates.la, lm.model.alpha);
      }
      dist.ess[stat] = rates.ess;
    }
    return dist;
  };

  // ---- Modelo de jugadores (tiros a puerta) ----
  const playersByName = new Map<string, PlayerGame[]>();
  for (const game of input.playerGames) {
    const key = normalizeName(game.playerName);
    const list = playersByName.get(key);
    if (list) list.push(game);
    else playersByName.set(key, [game]);
  }
  const playersByLastName = new Map<string, string[]>();
  for (const key of playersByName.keys()) {
    const last = key.split(" ").at(-1) ?? key;
    playersByLastName.set(last, [...(playersByLastName.get(last) ?? []), key]);
  }
  const resolvePlayer = (name: string): string | null => {
    const key = normalizeName(name);
    if (playersByName.has(key)) return key;
    const parts = key.split(" ");
    const last = parts.at(-1) ?? key;
    const candidates = (playersByLastName.get(last) ?? []).filter(
      (candidate) => candidate.charAt(0) === key.charAt(0),
    );
    return candidates.length === 1 ? candidates[0]! : null;
  };

  let playerPrior: { rate: number; alpha: number } | null = null;
  const propPlayerKeys = new Set<string>();
  const playerPriorFor = (): { rate: number; alpha: number } => {
    if (playerPrior) return playerPrior;
    // Prior = jugadores que las casas ofrecen como prop (delanteros/volantes ofensivos),
    // no la población completa (porteros y defensas sesgarían la tasa a la baja).
    const pool = propPlayerKeys.size >= 5 ? [...propPlayerKeys] : [...playersByName.keys()];
    let shots = 0;
    let minutes = 0;
    let varNum = 0;
    let varDen = 0;
    for (const key of pool) {
      const games = (playersByName.get(key) ?? []).filter(
        (g) => g.shots != null && g.minutes != null && g.minutes >= 20,
      );
      if (games.length < 8) continue;
      for (const g of games) {
        shots += g.shots!;
        minutes += g.minutes!;
      }
      if (games.length >= 10) {
        const mean = sum(games.map((g) => g.shots!)) / games.length;
        const variance = sum(games.map((g) => (g.shots! - mean) ** 2)) / (games.length - 1);
        varNum += variance - mean;
        varDen += mean * mean;
      }
    }
    playerPrior = {
      rate: minutes > 0 ? (shots / minutes) * 90 : 0.5,
      alpha: varDen > 0 ? clamp(varNum / varDen, 0, 0.8) : 0.3,
    };
    return playerPrior;
  };
  const playerCache = new Map<string, PlayerModel | null>();
  const playerModel = (name: string, kickoff: Date): PlayerModel | null => {
    const key = resolvePlayer(name);
    if (!key) return null;
    const cacheKey = `${key}|${kickoff.getTime()}`;
    if (playerCache.has(cacheKey)) return playerCache.get(cacheKey) ?? null;
    const games = (playersByName.get(key) ?? [])
      .filter((g) => g.kickoff < kickoff && g.kickoff < now && g.shots != null && g.minutes != null && g.minutes >= 20)
      .sort((a, b) => b.kickoff.getTime() - a.kickoff.getTime());
    let result: PlayerModel | null = null;
    if (games.length >= 8) {
      const expectedMinutes = Math.min(90, sum(games.slice(0, 5).map((g) => g.minutes!)) / Math.min(5, games.length));
      if (expectedMinutes >= 55) {
        const prior = playerPriorFor();
        const k = 2;
        let weightedShots = 0;
        let weightedGames = 0;
        let ess = 0;
        for (const g of games.slice(0, 20)) {
          const w = decay(now, g.kickoff, 120);
          weightedShots += w * g.shots!;
          weightedGames += (w * g.minutes!) / 90;
          ess += w;
        }
        const rate = (weightedShots + k * prior.rate) / (weightedGames + k);
        const lambda = (rate * expectedMinutes) / 90;
        result = { pmf: negBinPmf(lambda, prior.alpha), sampleSize: Math.round(ess) };
      }
    }
    playerCache.set(cacheKey, result);
    return result;
  };

  for (const quote of input.quotes) {
    if (quote.marketCategory === "shots-on-target" && quote.playerName) {
      const key = resolvePlayer(quote.playerName);
      if (key) propPlayerKeys.add(key);
    }
  }

  // ---- Recorrido por partido ----
  const outputs: PredictionOutput[] = [];
  const quotesByMatch = new Map<number, QuoteInput[]>();
  for (const quote of input.quotes) {
    if (now.getTime() - quote.capturedAt.getTime() > cfg.maxOddsAgeMs) continue;
    const list = quotesByMatch.get(quote.matchId);
    if (list) list.push(quote);
    else quotesByMatch.set(quote.matchId, [quote]);
  }

  for (const match of input.matches) {
    if (match.kickoff.getTime() - now.getTime() < cfg.minLeadMs) continue;
    const matchQuotes = quotesByMatch.get(match.id);
    if (!matchQuotes?.length) continue;

    type Entry = { quote: QuoteInput; c: ClassifiedQuote };
    // Solo la cuota más reciente de cada casa y selección.
    const latest = new Map<string, Entry>();
    for (const quote of matchQuotes) {
      const c = classifyQuote(quote, match);
      if (!c) continue;
      const key = `${quote.bookmaker}|${c.marketKey}|${c.selectionKey}`;
      const current = latest.get(key);
      const newer =
        !current ||
        quote.capturedAt > current.quote.capturedAt ||
        (quote.capturedAt.getTime() === current.quote.capturedAt.getTime() &&
          (quote.sourceUpdatedAt?.getTime() ?? 0) > (current.quote.sourceUpdatedAt?.getTime() ?? 0));
      if (newer) latest.set(key, { quote, c });
    }
    const entries = [...latest.values()];
    if (!entries.length) continue;

    // Quitar margen por casa y mercado -> consenso (mediana) entre casas.
    const bookGroups = new Map<string, Entry[]>();
    for (const entry of entries) {
      const key = `${entry.quote.bookmaker}|${entry.c.marketKey}`;
      const list = bookGroups.get(key);
      if (list) list.push(entry);
      else bookGroups.set(key, [entry]);
    }
    const consensusSamples = new Map<string, Map<SelectionKey, number[]>>();
    for (const group of bookGroups.values()) {
      const kind = group[0]!.c.kind;
      const keys = expectedKeys(kind);
      const bySelection = new Map(group.map((e) => [e.c.selectionKey, e.quote.decimalOdds]));
      if (!keys.every((k) => bySelection.has(k))) continue;
      const fair = devigPower(keys.map((k) => bySelection.get(k)!));
      if (!fair) continue;
      const consensusKey = group[0]!.c.consensusKey;
      const store = consensusSamples.get(consensusKey) ?? new Map<SelectionKey, number[]>();
      keys.forEach((k, i) => store.set(k, [...(store.get(k) ?? []), fair[i]!]));
      consensusSamples.set(consensusKey, store);
    }

    // Mejor precio por selección entre todas las casas.
    const best = new Map<string, { entry: Entry; books: number }>();
    for (const entry of entries) {
      const key = `${entry.c.consensusKey}|${entry.c.selectionKey}`;
      const current = best.get(key);
      if (!current) best.set(key, { entry, books: 1 });
      else {
        current.books += 1;
        if (entry.quote.decimalOdds > current.entry.quote.decimalOdds) current.entry = entry;
      }
    }

    const neededStats = new Set<StatKey>();
    for (const { entry } of best.values()) {
      neededStats.add(entry.c.kind === "result" ? "goals" : entry.c.stat);
    }
    const dist = distribution(match, neededStats);

    for (const { entry, books } of best.values()) {
      const { quote, c } = entry;
      const samples = consensusSamples.get(c.consensusKey);
      const keys = expectedKeys(c.kind);
      const minBooks = c.kind === "player" ? cfg.minBookmakersProps : cfg.minBookmakers;
      if (!samples || keys.some((k) => (samples.get(k)?.length ?? 0) < minBooks)) continue;
      const medians = keys.map((k) => median(samples.get(k)!));
      const norm = sum(medians);
      const marketProb = medians[keys.indexOf(c.selectionKey)]! / norm;
      const booksUsed = Math.min(...keys.map((k) => samples.get(k)!.length));

      // Probabilidad del modelo
      let raw: number | null = null;
      let ess = 0;
      let weightKey: keyof typeof maxModelWeight;
      if (c.kind === "result") {
        if (!dist.result) continue;
        raw = dist.result[c.selectionKey as "home" | "draw" | "away"];
        ess = dist.ess.goals ?? 0;
        weightKey = "match-result";
      } else if (c.kind === "total") {
        const pmf = dist.total[c.stat];
        if (!pmf || c.line == null) continue;
        const over = overProbability(pmf, c.line);
        raw = c.selectionKey === "over" ? over : 1 - over;
        ess = dist.ess[c.stat] ?? 0;
        weightKey = c.stat === "goals" ? "goals" : c.stat === "corners" ? "corners" : c.stat === "cards" ? "cards" : "shots-on-target";
      } else {
        const model = quote.playerName ? playerModel(quote.playerName, match.kickoff) : null;
        if (!model || c.line == null) continue;
        const over = overProbability(model.pmf, c.line);
        raw = c.selectionKey === "over" ? over : 1 - over;
        ess = model.sampleSize;
        weightKey = "player";
      }
      if (raw == null || !Number.isFinite(ess) || !(raw > 0)) continue;

      // Mezcla modelo/mercado: el modelo pesa más cuanta más muestra efectiva tenga.
      const weight = maxModelWeight[weightKey] * (ess / (ess + ESS_HALF_WEIGHT));
      const probability = clamp(weight * raw + (1 - weight) * marketProb, 0.001, 0.999);
      const odds = quote.decimalOdds;
      const gap = Math.abs(raw - marketProb);

      const evPct = (probability * odds - 1) * 100;
      const marketEvPct = (marketProb * odds - 1) * 100;
      if (odds < cfg.minOdds || odds > cfg.maxOdds) continue;
      if (evPct < cfg.minEvPct || evPct > cfg.maxEvPct) continue;
      // Un precio muy por encima del consenso suele ser una cuota vieja o errónea, no valor.
      if (marketEvPct > cfg.maxMarketEvPct) continue;
      // Doble confirmación: el modelo por sí solo también debe ver valor en este precio.
      if (raw * odds < 1) continue;
      // Si el modelo discrepa mucho del mercado, casi siempre le falta información (lesiones, alineación).
      if (raw - marketProb > cfg.maxModelMarketGap) continue;

      const fullKelly = (probability * odds - 1) / (odds - 1);
      const kellyFraction = clamp(fullKelly * cfg.kellyFraction, 0, cfg.maxStakeFraction);
      const confidence: "low" | "medium" | "high" =
        ess >= 20 && booksUsed >= 5 && gap <= 0.06 ? "high"
        : ess >= 12 && booksUsed >= 3 && gap <= 0.09 ? "medium"
        : "low";

      outputs.push({
        oddsQuoteId: quote.id,
        matchId: match.id,
        marketCategory: quote.marketCategory,
        marketName: quote.marketName,
        selection: quote.selection,
        selectionKey: c.selectionKey,
        line: c.line,
        playerName: quote.playerName,
        bookmaker: quote.bookmaker,
        decimalOdds: odds,
        rawModelProbability: raw,
        marketProbability: marketProb,
        modelProbability: probability,
        fairOdds: 1 / probability,
        expectedValuePct: evPct,
        kellyFraction,
        bookmakersCount: Math.max(books, booksUsed),
        sampleSize: Math.round(ess),
        confidence,
        modelVersion: MODEL_VERSION,
      });
    }
  }
  return outputs;
}
