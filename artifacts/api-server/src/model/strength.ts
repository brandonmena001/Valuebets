import { clamp, negBinPmf, poissonPmf, sum } from "./math";

/** Observación de un partido: valor del local, valor del visitante y peso temporal. */
export type Obs = { home: string; away: string; hv: number; av: number; w: number };

export type RateModel = {
  mu: number;
  ha: number;
  att: Map<string, number>;
  def: Map<string, number>;
  /** Partidos efectivos (suma de pesos) por equipo. */
  ess: Map<string, number>;
  rho: number;
  alpha: number;
  nObs: number;
};

/**
 * Modelo multiplicativo de tasas (Poisson con efectos de ataque, defensa y local):
 *   lambda_local     = mu * ha * att[local] * def[visitante]
 *   lambda_visitante = mu *      att[visit] * def[local]
 * Se estima por máxima verosimilitud ponderada (decaimiento exponencial por antigüedad)
 * con un prior Gamma que encoge cada equipo hacia el promedio de la liga. Sin ese
 * encogimiento, equipos con pocos partidos producen probabilidades extremas.
 */
export function fitRateModel(
  obs: Obs[],
  priorGames: number,
  options: { goals?: boolean; maxIter?: number } = {},
): RateModel | null {
  if (obs.length < 10) return null;
  const maxIter = options.maxIter ?? 300;
  const index = new Map<string, number>();
  const idx = (team: string): number => {
    let found = index.get(team);
    if (found === undefined) {
      found = index.size;
      index.set(team, found);
    }
    return found;
  };
  const H = obs.map((o) => idx(o.home));
  const A = obs.map((o) => idx(o.away));
  const n = obs.length;
  const T = index.size;
  const att = new Float64Array(T).fill(1);
  const def = new Float64Array(T).fill(1);

  let totalW = 0;
  let sumHome = 0;
  let sumAway = 0;
  for (const o of obs) {
    totalW += o.w;
    sumHome += o.w * o.hv;
    sumAway += o.w * o.av;
  }
  if (!(totalW > 0) || !(sumAway > 0) || !(sumHome > 0)) return null;
  let mu = sumAway / totalW;
  let ha = clamp(sumHome / sumAway, 0.7, 1.8);

  const attNum = new Float64Array(T);
  const attDen = new Float64Array(T);
  const defNum = new Float64Array(T);
  const defDen = new Float64Array(T);

  for (let iter = 0; iter < maxIter; iter += 1) {
    const k = priorGames * mu;
    attNum.fill(0);
    attDen.fill(0);
    for (let i = 0; i < n; i += 1) {
      const o = obs[i]!;
      const h = H[i]!;
      const a = A[i]!;
      attNum[h]! += o.w * o.hv;
      attDen[h]! += o.w * mu * ha * def[a]!;
      attNum[a]! += o.w * o.av;
      attDen[a]! += o.w * mu * def[h]!;
    }
    let maxDelta = 0;
    for (let t = 0; t < T; t += 1) {
      const next = (attNum[t]! + k) / (attDen[t]! + k);
      maxDelta = Math.max(maxDelta, Math.abs(next - att[t]!));
      att[t] = next;
    }

    defNum.fill(0);
    defDen.fill(0);
    for (let i = 0; i < n; i += 1) {
      const o = obs[i]!;
      const h = H[i]!;
      const a = A[i]!;
      defNum[h]! += o.w * o.av;
      defDen[h]! += o.w * mu * att[a]!;
      defNum[a]! += o.w * o.hv;
      defDen[a]! += o.w * mu * ha * att[h]!;
    }
    for (let t = 0; t < T; t += 1) {
      const next = (defNum[t]! + k) / (defDen[t]! + k);
      maxDelta = Math.max(maxDelta, Math.abs(next - def[t]!));
      def[t] = next;
    }

    let numerator = 0;
    let muDen = 0;
    let haDen = 0;
    for (let i = 0; i < n; i += 1) {
      const o = obs[i]!;
      const h = H[i]!;
      const a = A[i]!;
      numerator += o.w * (o.hv + o.av);
      muDen += o.w * (ha * att[h]! * def[a]! + att[a]! * def[h]!);
      haDen += o.w * att[h]! * def[a]!;
    }
    mu = numerator / muDen;
    ha = clamp(sumHome / (mu * haDen), 0.7, 1.8);

    // Normaliza (media geométrica = 1) para que los efectos sean identificables.
    let logAtt = 0;
    let logDef = 0;
    for (let t = 0; t < T; t += 1) {
      logAtt += Math.log(att[t]!);
      logDef += Math.log(def[t]!);
    }
    const gmAtt = Math.exp(logAtt / T);
    const gmDef = Math.exp(logDef / T);
    for (let t = 0; t < T; t += 1) {
      att[t] = att[t]! / gmAtt;
      def[t] = def[t]! / gmDef;
    }
    mu *= gmAtt * gmDef;

    if (maxDelta < 1e-8 && iter > 5) break;
  }

  const ess = new Map<string, number>();
  const attMap = new Map<string, number>();
  const defMap = new Map<string, number>();
  const essArr = new Float64Array(T);
  for (let i = 0; i < n; i += 1) {
    essArr[H[i]!]! += obs[i]!.w;
    essArr[A[i]!]! += obs[i]!.w;
  }
  for (const [team, t] of index) {
    attMap.set(team, att[t]!);
    defMap.set(team, def[t]!);
    ess.set(team, essArr[t]!);
  }

  const lambdas = obs.map((o, i) => ({
    lh: mu * ha * att[H[i]!]! * def[A[i]!]!,
    la: mu * att[A[i]!]! * def[H[i]!]!,
  }));

  let rho = 0;
  let alpha = 0;
  if (options.goals) {
    rho = fitRho(obs, lambdas);
  } else {
    // Dispersión NB2 por método de momentos, con corrección por grados de libertad.
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i += 1) {
      const o = obs[i]!;
      const { lh, la } = lambdas[i]!;
      num += o.w * ((o.hv - lh) ** 2 - lh + ((o.av - la) ** 2 - la));
      den += o.w * (lh * lh + la * la);
    }
    const dfFactor = Math.min(1.5, (2 * n) / Math.max(1, 2 * n - (2 * T + 2)));
    alpha = den > 0 ? clamp((num / den) * dfFactor, 0, 1.5) : 0;
  }

  return { mu, ha, att: attMap, def: defMap, ess, rho, alpha, nObs: n };
}

function tau(x: number, y: number, lh: number, la: number, rho: number): number {
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/** Parámetro de correlación de Dixon-Coles (marcadores bajos), por búsqueda en rejilla. */
function fitRho(obs: Obs[], lambdas: Array<{ lh: number; la: number }>): number {
  let best = 0;
  let bestLl = -Infinity;
  for (let step = -25; step <= 10; step += 1) {
    const rho = step / 100;
    let ll = 0;
    let valid = true;
    for (let i = 0; i < obs.length; i += 1) {
      const o = obs[i]!;
      if (o.hv > 1 || o.av > 1) continue;
      const { lh, la } = lambdas[i]!;
      const t = tau(o.hv, o.av, lh, la, rho);
      if (!(t > 0)) {
        valid = false;
        break;
      }
      ll += o.w * Math.log(t);
    }
    if (valid && ll > bestLl) {
      bestLl = ll;
      best = rho;
    }
  }
  return best;
}

export function expectedRates(
  model: RateModel,
  home: string,
  away: string,
): { lh: number; la: number; ess: number } | null {
  const attHome = model.att.get(home);
  const defHome = model.def.get(home);
  const attAway = model.att.get(away);
  const defAway = model.def.get(away);
  const essHome = model.ess.get(home);
  const essAway = model.ess.get(away);
  if (
    attHome === undefined || defHome === undefined || attAway === undefined ||
    defAway === undefined || essHome === undefined || essAway === undefined
  ) return null;
  return {
    lh: model.mu * model.ha * attHome * defAway,
    la: model.mu * attAway * defHome,
    ess: Math.min(essHome, essAway),
  };
}

/** Matriz de marcadores con la corrección de Dixon-Coles, normalizada a suma 1. */
export function scoreMatrix(lh: number, la: number, rho: number): number[][] {
  const ph = poissonPmf(lh, 1e-10);
  const pa = poissonPmf(la, 1e-10);
  const matrix: number[][] = [];
  let total = 0;
  for (let i = 0; i < ph.length; i += 1) {
    const row: number[] = [];
    for (let j = 0; j < pa.length; j += 1) {
      const value = Math.max(0, ph[i]! * pa[j]! * tau(i, j, lh, la, rho));
      row.push(value);
      total += value;
    }
    matrix.push(row);
  }
  return matrix.map((row) => row.map((value) => value / total));
}

export function resultProbs(matrix: number[][]): { home: number; draw: number; away: number } {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let i = 0; i < matrix.length; i += 1) {
    for (let j = 0; j < matrix[i]!.length; j += 1) {
      const value = matrix[i]![j]!;
      if (i > j) home += value;
      else if (i === j) draw += value;
      else away += value;
    }
  }
  return { home, draw, away };
}

export function totalGoalsPmf(matrix: number[][]): number[] {
  const out: number[] = [];
  for (let i = 0; i < matrix.length; i += 1) {
    for (let j = 0; j < matrix[i]!.length; j += 1) {
      out[i + j] = (out[i + j] ?? 0) + matrix[i]![j]!;
    }
  }
  return out;
}

/**
 * Distribución del total (local + visitante) para conteos sobredispersos.
 * Se aproxima la suma de dos NB2 con otra NB2 de la misma media y varianza.
 */
export function totalCountPmf(lh: number, la: number, alpha: number): number[] {
  const mean = lh + la;
  const alphaTotal = (alpha * (lh * lh + la * la)) / (mean * mean);
  return negBinPmf(mean, alphaTotal);
}

export { sum };
