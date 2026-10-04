export function sum(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** PMF de Poisson truncada cuando la masa acumulada supera 1 - eps. */
export function poissonPmf(lambda: number, eps = 1e-12): number[] {
  const rate = Math.max(lambda, 1e-9);
  const pmf = [Math.exp(-rate)];
  let cumulative = pmf[0]!;
  for (let k = 0; cumulative < 1 - eps && k < 400; k += 1) {
    const next = (pmf[k]! * rate) / (k + 1);
    pmf.push(next);
    cumulative += next;
  }
  return pmf;
}

/**
 * Binomial negativa (NB2): media m, varianza m + alpha * m^2.
 * Los conteos de córners, tarjetas y tiros tienen sobredispersión: con Poisson
 * se subestiman las colas y salen "value bets" falsos en las líneas extremas.
 */
export function negBinPmf(mean: number, alpha: number, eps = 1e-12): number[] {
  if (alpha < 1e-4) return poissonPmf(mean, eps);
  const m = Math.max(mean, 1e-9);
  const r = 1 / alpha;
  const q = m / (r + m);
  const pmf = [Math.exp(r * Math.log(r / (r + m)))];
  let cumulative = pmf[0]!;
  for (let k = 0; cumulative < 1 - eps && k < 400; k += 1) {
    const next = (pmf[k]! * (k + r) * q) / (k + 1);
    pmf.push(next);
    cumulative += next;
  }
  return pmf;
}

/** P(X >= n) */
export function probAtLeast(pmf: number[], n: number): number {
  if (n <= 0) return 1;
  let below = 0;
  for (let k = 0; k < Math.min(n, pmf.length); k += 1) below += pmf[k]!;
  return clamp(1 - below, 0, 1);
}

/** P(X > line) para líneas .5 */
export function overProbability(pmf: number[], line: number): number {
  return probAtLeast(pmf, Math.floor(line) + 1);
}

/**
 * Quita el margen de la casa con el método de potencia: busca c tal que
 * sum((1/odds)^c) = 1. Reparte el margen de forma más realista que normalizar
 * proporcionalmente (carga más margen a los favoritos improbables).
 * Devuelve null si el grupo de cuotas es inválido o está incompleto.
 */
export function devigPower(odds: number[]): number[] | null {
  if (odds.length < 2 || odds.some((value) => !(value > 1))) return null;
  const implied = odds.map((value) => 1 / value);
  const total = sum(implied);
  if (total < 1 || total > 1.3) return null;
  let low = 1;
  let high = 8;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    const f = sum(implied.map((value) => value ** mid));
    if (f > 1) low = mid;
    else high = mid;
  }
  const exponent = (low + high) / 2;
  const adjusted = implied.map((value) => value ** exponent);
  const norm = sum(adjusted);
  return adjusted.map((value) => value / norm);
}
