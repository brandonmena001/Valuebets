import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/** Banca e historial de cupones. Todo se guarda solo en este navegador (localStorage). */

export type BetResult = 'pending' | 'won' | 'lost' | 'void';

export type HistorySelection = { match: string; market: string; selection: string; probability: number };

export type HistoryEntry = {
  id: string;
  savedAt: string;
  selections: HistorySelection[];
  houseOdds: number;
  stake: number;
  /** Probabilidad combinada del cupón en el momento de registrarlo. */
  probability: number;
  /** EV (%) frente a la cuota de la casa en el momento de registrarlo. */
  evPct: number | null;
  result: BetResult;
  /** Lo que este resultado ya sumó o restó a la banca (para poder revertirlo si se corrige). */
  appliedDelta: number;
};

export type NewHistoryEntry = Omit<HistoryEntry, 'id' | 'savedAt' | 'result' | 'appliedDelta'>;

const BANKROLL_KEY = 'value-bets-bankroll-v1';
const HISTORY_KEY = 'value-bets-history-v1';
const MAX_HISTORY = 200;

type State = { bankroll: number | null; history: HistoryEntry[] };

type BankrollContextValue = State & {
  setBankroll: (value: number | null) => void;
  register: (entry: NewHistoryEntry) => void;
  settle: (id: string, result: BetResult) => void;
  remove: (id: string) => void;
};

const BankrollContext = createContext<BankrollContextValue | null>(null);

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Ganancia o pérdida neta de una apuesta según su resultado. */
export function profitOf(entry: Pick<HistoryEntry, 'stake' | 'houseOdds'>, result: BetResult): number {
  if (result === 'won') return round2(entry.stake * (entry.houseOdds - 1));
  if (result === 'lost') return round2(-entry.stake);
  return 0;
}

function isEntry(value: unknown): value is HistoryEntry {
  const entry = value as HistoryEntry | null;
  return !!entry && typeof entry.id === 'string' && typeof entry.savedAt === 'string' && Array.isArray(entry.selections)
    && Number.isFinite(entry.houseOdds) && Number.isFinite(entry.stake) && Number.isFinite(entry.probability)
    && ['pending', 'won', 'lost', 'void'].includes(entry.result) && Number.isFinite(entry.appliedDelta);
}

function load(): State {
  try {
    const rawBankroll = window.localStorage.getItem(BANKROLL_KEY);
    const bankroll = rawBankroll == null || rawBankroll === '' ? null : Number(rawBankroll);
    const rawHistory = window.localStorage.getItem(HISTORY_KEY);
    const parsed: unknown = rawHistory ? JSON.parse(rawHistory) : [];
    return {
      bankroll: bankroll != null && Number.isFinite(bankroll) && bankroll >= 0 ? bankroll : null,
      history: Array.isArray(parsed) ? parsed.filter(isEntry) : [],
    };
  } catch {
    return { bankroll: null, history: [] };
  }
}

export function BankrollProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(load);
  useEffect(() => {
    try {
      if (state.bankroll == null) window.localStorage.removeItem(BANKROLL_KEY);
      else window.localStorage.setItem(BANKROLL_KEY, String(state.bankroll));
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
    } catch { /* almacenamiento no disponible */ }
  }, [state]);

  const setBankroll = useCallback((value: number | null) => setState(current => ({ ...current, bankroll: value == null ? null : round2(value) })), []);

  const register = useCallback((entry: NewHistoryEntry) => setState(current => ({
    ...current,
    history: [{
      ...entry,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      savedAt: new Date().toISOString(),
      result: 'pending' as const,
      appliedDelta: 0,
    }, ...current.history].slice(0, MAX_HISTORY),
  })), []);

  const settle = useCallback((id: string, result: BetResult) => setState(current => {
    const entry = current.history.find(item => item.id === id);
    if (!entry || entry.result === result) return current;
    // Se revierte lo aplicado antes y se aplica el efecto del nuevo resultado, así corregir un error no descuadra la banca.
    const delta = current.bankroll == null ? 0 : profitOf(entry, result);
    const bankroll = current.bankroll == null ? null : Math.max(0, round2(current.bankroll - entry.appliedDelta + delta));
    return {
      bankroll,
      history: current.history.map(item => item.id === id ? { ...item, result, appliedDelta: delta } : item),
    };
  }), []);

  const remove = useCallback((id: string) => setState(current => {
    const entry = current.history.find(item => item.id === id);
    if (!entry) return current;
    const bankroll = current.bankroll == null ? null : Math.max(0, round2(current.bankroll - entry.appliedDelta));
    return { bankroll, history: current.history.filter(item => item.id !== id) };
  }), []);

  const value = useMemo<BankrollContextValue>(() => ({ ...state, setBankroll, register, settle, remove }), [state, setBankroll, register, settle, remove]);
  return <BankrollContext.Provider value={value}>{children}</BankrollContext.Provider>;
}

export function useBankroll(): BankrollContextValue {
  const context = useContext(BankrollContext);
  if (!context) throw new Error('useBankroll debe usarse dentro de BankrollProvider');
  return context;
}

export type HistorySummary = { bets: number; settled: number; pending: number; staked: number; net: number; roiPct: number | null };

/** Resumen del historial: el ROI solo cuenta apuestas ya resueltas (ganadas o perdidas). */
export function summarizeHistory(history: HistoryEntry[]): HistorySummary {
  const resolved = history.filter(entry => entry.result === 'won' || entry.result === 'lost');
  const staked = resolved.reduce((total, entry) => total + entry.stake, 0);
  const net = resolved.reduce((total, entry) => total + profitOf(entry, entry.result), 0);
  return {
    bets: history.length,
    settled: resolved.length,
    pending: history.filter(entry => entry.result === 'pending').length,
    staked: round2(staked),
    net: round2(net),
    roiPct: staked > 0 ? (net / staked) * 100 : null,
  };
}
