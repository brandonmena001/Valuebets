import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type SlipItem = {
  id: string;
  fixtureId: string;
  match: string;
  market: string;
  selection: string;
  /** Probabilidad que usa el cupón para calcular valor. */
  probability: number;
  /** 'blend' = ya mezclada con el consenso del mercado; 'model' = modelo puro. */
  source: 'blend' | 'model';
  /** Cuota de la casa sugerida (p. ej. la mejor cuota de una value bet). */
  houseOdds?: number | null;
};

const STORAGE_KEY = 'value-bets-slip-v1';
const FRACTIONAL_KELLY = 0.25;
const MAX_STAKE_FRACTION = 0.02;
const ASSUMED_MARGIN = 0.05;

type SlipContextValue = {
  items: SlipItem[];
  add: (item: SlipItem) => void;
  remove: (id: string) => void;
  clear: () => void;
  has: (id: string) => boolean;
};

const SlipContext = createContext<SlipContextValue | null>(null);

function load(): SlipItem[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as SlipItem[]).filter(item => typeof item?.id === 'string' && Number.isFinite(item.probability)) : [];
  } catch {
    return [];
  }
}

export function SlipProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<SlipItem[]>(load);
  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch { /* almacenamiento no disponible */ }
  }, [items]);
  const add = useCallback((item: SlipItem) => setItems(current => current.some(entry => entry.id === item.id) ? current : [...current, item]), []);
  const remove = useCallback((id: string) => setItems(current => current.filter(entry => entry.id !== id)), []);
  const clear = useCallback(() => setItems([]), []);
  const value = useMemo<SlipContextValue>(() => ({ items, add, remove, clear, has: id => items.some(entry => entry.id === id) }), [items, add, remove, clear]);
  return <SlipContext.Provider value={value}>{children}</SlipContext.Provider>;
}

export function useSlip(): SlipContextValue {
  const context = useContext(SlipContext);
  if (!context) throw new Error('useSlip debe usarse dentro de SlipProvider');
  return context;
}

export function slipItemId(fixtureId: string, market: string, selection: string): string {
  return `${fixtureId}|${market}|${selection}`;
}

export type SlipAnalysis = {
  probability: number;
  fairOdds: number;
  sameMatch: boolean;
  hasPureModel: boolean;
  houseOdds: number | null;
  evPct: number | null;
  evPer100: number | null;
  hasValue: boolean | null;
  /** Kelly completo (fracción de la banca). Solo informativo: es muy agresivo. */
  fullKelly: number | null;
  /** Fracción de banca recomendada: Kelly al 25 % con tope del 2 %. */
  suggestedFraction: number | null;
  /** EV recalculado mezclando el modelo con la probabilidad implícita de la cuota de la casa. */
  prudentEvPct: number | null;
  prudentProbability: number | null;
};

export function analyzeSlip(items: SlipItem[], houseOdds: number | null): SlipAnalysis {
  const probability = items.reduce((total, item) => total * item.probability, 1);
  const fairOdds = probability > 0 ? 1 / probability : Infinity;
  const fixtures = new Set(items.map(item => item.fixtureId));
  const base: SlipAnalysis = {
    probability, fairOdds, sameMatch: items.length > 1 && fixtures.size < items.length,
    hasPureModel: items.some(item => item.source === 'model'),
    houseOdds: null, evPct: null, evPer100: null, hasValue: null, fullKelly: null,
    suggestedFraction: null, prudentEvPct: null, prudentProbability: null,
  };
  if (!houseOdds || !(houseOdds > 1) || !(probability > 0)) return base;
  const ev = probability * houseOdds - 1;
  const fullKelly = Math.max(0, ev / (houseOdds - 1));
  // La cuota de la casa también es información: se asume un margen típico y se mezcla 50/50.
  const marketProbability = Math.min(0.999, 1 / (houseOdds * (1 + ASSUMED_MARGIN) ** items.length));
  const prudentProbability = 0.5 * probability + 0.5 * marketProbability;
  const prudentEv = prudentProbability * houseOdds - 1;
  return {
    ...base, houseOdds, evPct: ev * 100, evPer100: ev * 100, hasValue: ev > 0, fullKelly,
    suggestedFraction: Math.min(MAX_STAKE_FRACTION, Math.max(0, (prudentEv / (houseOdds - 1)) * FRACTIONAL_KELLY)),
    prudentEvPct: prudentEv * 100, prudentProbability,
  };
}
