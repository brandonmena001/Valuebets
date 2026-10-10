/**
 * Líneas con push (enteras) y cuartos (2.25, -0.75...): totales y hándicap asiático.
 *
 * Una línea de cuarto se reparte mitad en cada línea vecina (2.25 = 2 y 2.5).
 * Resultado posible por apuesta: win, half-win, push (se devuelve), half-loss, loss.
 *
 * Probabilidad efectiva: para comparar con el mercado se usa el reparto "sin push"
 *   A = win + halfWin/2,  B = loss + halfLoss/2,  prob = A / (A + B),  risk = A + B
 * (el devig a dos vías de las cuotas de una línea da justo esa prob.). El EV real de
 * la apuesta a cuota `o` es A*(o-1) - B = risk * (prob*o - 1); el Kelly óptimo usa `prob`.
 */
export type LineResult = "win" | "half-win" | "push" | "half-loss" | "loss";

export type LineOutcome = { win: number; halfWin: number; push: number; halfLoss: number; loss: number };

const EPS = 1e-9;

export function isValidLine(line: number): boolean {
  return Number.isFinite(line) && Math.abs(line * 4 - Math.round(line * 4)) < EPS;
}

/** Líneas simples en las que se reparte la apuesta (1 si es entera o .5; 2 si es de cuarto). */
export function splitLine(threshold: number): number[] {
  if (Math.abs(threshold * 2 - Math.round(threshold * 2)) < EPS) return [threshold];
  if (!isValidLine(threshold)) throw new Error(`Línea inválida: ${threshold}`);
  return [threshold - 0.25, threshold + 0.25];
}

/**
 * Resultado de apostar "por encima" (side = 1) o "por debajo" (side = -1) de `threshold`
 * cuando la variable (total, o diferencia de goles local-visitante) vale `value`.
 * Totales: threshold = línea. Hándicap asiático al local con línea h: threshold = -h
 * (local = side 1, visitante = side -1).
 */
export function resultFor(value: number, threshold: number, side: 1 | -1): LineResult {
  const legs = splitLine(threshold).map((sub) => {
    const diff = (value - sub) * side;
    return Math.abs(diff) < EPS ? 0 : diff > 0 ? 1 : -1;
  });
  const total = legs.reduce((a, b) => a + b, 0);
  if (legs.length === 1) return total === 1 ? "win" : total === 0 ? "push" : "loss";
  return total === 2 ? "win" : total === 1 ? "half-win" : total === 0 ? "push" : total === -1 ? "half-loss" : "loss";
}

/** Ganancia neta por unidad apostada a cuota decimal `odds`. */
export function lineReturn(result: LineResult, odds: number): number {
  switch (result) {
    case "win": return odds - 1;
    case "half-win": return (odds - 1) / 2;
    case "push": return 0;
    case "half-loss": return -0.5;
    default: return -1;
  }
}

export function emptyOutcome(): LineOutcome {
  return { win: 0, halfWin: 0, push: 0, halfLoss: 0, loss: 0 };
}

function addTo(outcome: LineOutcome, result: LineResult, p: number): void {
  if (result === "win") outcome.win += p;
  else if (result === "half-win") outcome.halfWin += p;
  else if (result === "push") outcome.push += p;
  else if (result === "half-loss") outcome.halfLoss += p;
  else outcome.loss += p;
}

/**
 * Distribución de resultados de la apuesta. `pmf[k]` es la probabilidad de que la
 * variable valga `k + offset`. La masa que falte para llegar a 1 (cola truncada) se
 * asigna al valor siguiente al último.
 */
export function lineOutcomeFromPmf(pmf: number[], offset: number, threshold: number, side: 1 | -1): LineOutcome {
  const outcome = emptyOutcome();
  let mass = 0;
  for (let k = 0; k < pmf.length; k += 1) {
    const p = pmf[k] ?? 0;
    if (p <= 0) continue;
    mass += p;
    addTo(outcome, resultFor(k + offset, threshold, side), p);
  }
  const rest = 1 - mass;
  if (rest > 0) addTo(outcome, resultFor(pmf.length + offset, threshold, side), rest);
  return outcome;
}

/** Distribución de (goles local - goles visitante) a partir de la matriz de marcadores. */
export function marginPmf(matrix: number[][]): { pmf: number[]; offset: number } {
  const cols = matrix[0]?.length ?? 0;
  const offset = -(cols - 1);
  const pmf = new Array<number>(matrix.length + cols - 1).fill(0);
  for (let i = 0; i < matrix.length; i += 1) {
    for (let j = 0; j < cols; j += 1) pmf[i - j - offset]! += matrix[i]![j]!;
  }
  return { pmf, offset };
}

/** Probabilidad de que ambos equipos anoten. */
export function bttsProbability(matrix: number[][]): number {
  let yes = 0;
  for (let i = 1; i < matrix.length; i += 1) {
    for (let j = 1; j < matrix[i]!.length; j += 1) yes += matrix[i]![j]!;
  }
  return Math.min(1, Math.max(0, yes));
}

export function effectiveProbability(o: LineOutcome): { prob: number; risk: number } {
  const a = o.win + o.halfWin / 2;
  const b = o.loss + o.halfLoss / 2;
  const risk = a + b;
  return { prob: risk > 0 ? a / risk : 0.5, risk };
}
