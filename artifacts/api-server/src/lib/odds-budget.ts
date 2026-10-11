const HOUR = 3_600_000;

export type CapturePlanOptions = {
  /** Horas antes del primer partido sin cubrir en que se captura (por defecto 3). */
  leadHours?: number;
  /** Una captura cubre partidos que empiezan entre minLead y maxLead horas después (1 a 5 por defecto). */
  minLeadHours?: number;
  maxLeadHours?: number;
  /** Llamadas por captura = casas consultadas (BetPlay y Betano = 2). */
  callsPerCapture?: number;
  /** Llamadas fijas al mes (catálogos cada 7 días y torneos): ~17. */
  overheadCalls?: number;
  cap?: number;
};

export type Capture = { at: Date; covers: number };
export type CapturePlan = {
  captures: Capture[];
  matches: number;
  uncovered: number;
  calls: number;
  withinCap: boolean;
};

/**
 * Calendario de capturas "antes del inicio": por cada partido aún sin cubrir se captura
 * `leadHours` antes y esa captura sirve a todos los que empiezan 1–5 h después. Si el gasto
 * supera la cuota, se descartan las capturas que cubren menos partidos hasta que quepa.
 */
export function planCaptures(kickoffs: Date[], options: CapturePlanOptions = {}): CapturePlan {
  const lead = (options.leadHours ?? 3) * HOUR;
  const min = (options.minLeadHours ?? 1) * HOUR;
  const max = (options.maxLeadHours ?? 5) * HOUR;
  const perCapture = options.callsPerCapture ?? 2;
  const overhead = options.overheadCalls ?? 17;
  const cap = options.cap ?? 200;
  const sorted = kickoffs.map((d) => d.getTime()).sort((a, b) => a - b);
  let captures: Capture[] = [];
  for (let i = 0; i < sorted.length; ) {
    const at = sorted[i]! - lead;
    let j = i;
    while (j < sorted.length && sorted[j]! <= at + max) j += 1;
    captures.push({ at: new Date(at), covers: sorted.slice(i, j).filter((k) => k >= at + min).length });
    i = j;
  }
  const budget = Math.max(0, Math.floor((cap - overhead) / perCapture));
  if (captures.length > budget) {
    const keep = new Set([...captures].sort((a, b) => b.covers - a.covers || a.at.getTime() - b.at.getTime()).slice(0, budget));
    captures = captures.filter((c) => keep.has(c));
  }
  const covered = captures.reduce((sum, c) => sum + c.covers, 0);
  const calls = captures.length * perCapture + overhead;
  return { captures, matches: sorted.length, uncovered: Math.max(0, sorted.length - covered), calls, withinCap: calls <= cap };
}

/** Comparación: gasto con intervalo fijo (una sincronización cada `everyHours` durante `days` días). */
export function fixedIntervalCalls(days: number, everyHours: number, callsPerSync = 2, overhead = 17): number {
  return Math.ceil((days * 24) / everyHours) * callsPerSync + overhead;
}
