const numberFormats = new Map<number, Intl.NumberFormat>();

function numberFormat(decimals: number): Intl.NumberFormat {
  let format = numberFormats.get(decimals);
  if (!format) {
    format = new Intl.NumberFormat('es-CO', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    numberFormats.set(decimals, format);
  }
  return format;
}

/** Número con coma decimal; «—» cuando no hay dato (la ausencia de dato no es cero). */
export function formatValue(value: number | null | undefined, decimals = 1): string {
  return value == null || !Number.isFinite(value) ? '—' : numberFormat(decimals).format(value);
}

/** Igual que formatValue pero con «+» explícito en los positivos (para ROI, EV, CLV). */
export function formatSigned(value: number | null | undefined, decimals = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${numberFormat(decimals).format(value)}`;
}

/** Fracción 0–1 → porcentaje (0.256 → «25,6%»). */
export function formatPct(fraction: number | null | undefined, decimals = 1): string {
  return fraction == null || !Number.isFinite(fraction) ? '—' : `${numberFormat(decimals).format(fraction * 100)}%`;
}

const DEFAULT_DATE: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' };

export function formatDate(value?: string | Date | null, options?: Intl.DateTimeFormatOptions): string {
  if (!value) return 'Sin datos';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Fecha no disponible';
  return new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', ...(options ?? DEFAULT_DATE) }).format(date);
}

/** Cuota decimal justa a partir de una probabilidad; «—» si la probabilidad es ~0. */
export function formatFairOdds(probability: number): string {
  return probability > 0.001 ? (1 / probability).toFixed(2) : '—';
}
