import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, History, Save, Ticket, Trash2, Wallet, X } from 'lucide-react';
import { Link } from 'wouter';
import { EmptyState } from '@/components/states';
import { profitOf, summarizeHistory, useBankroll, type BetResult, type HistoryEntry } from '@/lib/bankroll';
import { formatDate, formatPct, formatSigned, formatValue } from '@/lib/format';
import { analyzeSlip, useSlip } from '@/lib/slip';

const num = (value: string): number | null => {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const money = (value: number, signed = false) => (signed ? formatSigned(value, 2) : formatValue(value, 2));

const resultLabels: Record<BetResult, string> = { pending: 'Pendiente', won: 'Ganó', lost: 'Perdió', void: 'Nula' };

function BankrollCard({ bankrollText, setBankrollText, invalid }: { bankrollText: string; setBankrollText: (value: string) => void; invalid: boolean }) {
  return <section className="fd-card" data-testid="card-bankroll">
    <h2 className="fd-h"><Wallet size={14} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 6 }} />Banca</h2>
    <label className="fd-label" htmlFor="bankroll">Banca actual (se guarda en este dispositivo)</label>
    <input id="bankroll" className="field fd-input" inputMode="decimal" placeholder="Ej: 500" value={bankrollText} onChange={event => setBankrollText(event.target.value)} aria-invalid={invalid} data-testid="input-bankroll" />
    {invalid && <div className="fd-bet-sub" style={{ marginTop: 6 }}>Escribe un número mayor que 0.</div>}
    <div className="fd-bet-sub" style={{ marginTop: 8 }}>Al marcar una apuesta del historial como ganada o perdida, la banca se ajusta sola; puedes corregirla aquí en cualquier momento.</div>
  </section>;
}

function HistoryItem({ entry, onSettle, onRemove }: { entry: HistoryEntry; onSettle: (result: BetResult) => void; onRemove: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const profit = profitOf(entry, entry.result);
  const first = entry.selections[0];
  return <article className="fd-card hist-item" data-testid={`history-item-${entry.id}`}>
    <div className="hist-top">
      <span className="fd-bet-sub">{formatDate(entry.savedAt)}</span>
      <span className={`hist-badge ${entry.result}`}>{resultLabels[entry.result]}</span>
    </div>
    <ul className="hist-selections">
      {entry.selections.map(selection => <li key={`${selection.match}|${selection.market}|${selection.selection}`}>
        <span className="fd-bet-match">{selection.match}</span>
        <strong>{selection.selection}</strong> <span className="fd-bet-sub">· {selection.market}</span>
      </li>)}
    </ul>
    {!first && <div className="fd-bet-sub">Sin selecciones guardadas.</div>}
    <div className="hist-meta">
      <span>Cuota <strong className="mono">{formatValue(entry.houseOdds, 2)}</strong></span>
      <span>Stake <strong className="mono">{money(entry.stake)}</strong></span>
      <span>EV <strong className="mono">{entry.evPct == null ? '—' : `${formatSigned(entry.evPct)}%`}</strong></span>
      {entry.result !== 'pending' && <span>Neto <strong className={`mono ${profit > 0 ? 'fd-good' : profit < 0 ? 'fd-bad' : ''}`}>{money(profit, true)}</strong></span>}
    </div>
    <div className="hist-actions" role="group" aria-label="Resultado de la apuesta">
      {(Object.keys(resultLabels) as BetResult[]).map(result => <button key={result} type="button" className={`hist-result ${entry.result === result ? 'active' : ''}`} aria-pressed={entry.result === result} onClick={() => onSettle(result)} data-testid={`button-result-${result}-${entry.id}`}>{resultLabels[result]}</button>)}
    </div>
    <div className="hist-remove">
      {confirming
        ? <><span className="fd-bet-sub">¿Borrar del historial?{entry.appliedDelta !== 0 ? ' La banca se revertirá.' : ''}</span>
          <button type="button" className="button" onClick={onRemove} data-testid={`button-confirm-delete-${entry.id}`}>Sí, borrar</button>
          <button type="button" className="button" onClick={() => setConfirming(false)}>Cancelar</button></>
        : <button type="button" className="button" onClick={() => setConfirming(true)} data-testid={`button-delete-${entry.id}`}><Trash2 size={14} aria-hidden="true" /> Borrar</button>}
    </div>
  </article>;
}

function HistorySection() {
  const { history, settle, remove } = useBankroll();
  const summary = useMemo(() => summarizeHistory(history), [history]);
  return <section data-testid="section-history">
    <h2 className="fd-h" style={{ margin: '6px 0 10px' }}><History size={14} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 6 }} />Historial de apuestas</h2>
    {!history.length ? <section className="fd-card"><EmptyState title="Aún no has registrado apuestas" copy="Cuando compares un cupón con la cuota de tu casa y pulses «Registrar apuesta», quedará aquí para seguir tu resultado real. Solo se guarda en este dispositivo." /></section> : <>
      <div className="metric-grid perf-grid">
        <div className="panel metric"><div className="metric-label">Apuestas</div><div className="metric-value">{summary.bets}</div><div className="metric-foot">{summary.pending} pendientes</div></div>
        <div className="panel metric"><div className="metric-label">Neto</div><div className={`metric-value ${summary.net > 0 ? 'perf-good' : summary.net < 0 ? 'perf-bad' : ''}`}>{money(summary.net, true)}</div><div className="metric-foot">Sobre {summary.settled} resueltas</div></div>
        <div className="panel metric"><div className="metric-label">ROI propio</div><div className="metric-value">{summary.roiPct == null ? '—' : `${formatSigned(summary.roiPct)}%`}</div><div className="metric-foot">Apostado {money(summary.staked)}</div></div>
      </div>
      {summary.settled < 30 && <div className="fd-bet-sub" style={{ margin: '4px 0 8px' }}>Con pocas apuestas resueltas el ROI es mayormente suerte; no saques conclusiones todavía.</div>}
      <div className="hist-list">{history.map(entry => <HistoryItem key={entry.id} entry={entry} onSettle={result => settle(entry.id, result)} onRemove={() => remove(entry.id)} />)}</div>
    </>}
  </section>;
}

export default function SlipPage() {
  const { items, remove, clear } = useSlip();
  const { bankroll, setBankroll, register } = useBankroll();
  const [oddsText, setOddsText] = useState('');
  const [stakeText, setStakeText] = useState('');
  const [bankrollText, setBankrollText] = useState(bankroll == null ? '' : String(bankroll));
  const [notice, setNotice] = useState('');

  // La banca puede cambiar desde el historial (al resolver una apuesta): se refleja en el campo.
  useEffect(() => {
    if (num(bankrollText) !== bankroll) setBankrollText(bankroll == null ? '' : String(bankroll));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bankroll]);
  const onBankrollText = (value: string) => {
    setBankrollText(value);
    setBankroll(value.trim() === '' ? null : num(value));
  };

  const suggested = items.length === 1 ? items[0]?.houseOdds : null;
  const houseOdds = num(oddsText) ?? (oddsText === '' ? suggested ?? null : null);
  const analysis = useMemo(() => analyzeSlip(items, houseOdds), [items, houseOdds]);
  const stake = num(stakeText);
  const suggestedStake = bankroll && analysis.suggestedFraction ? bankroll * analysis.suggestedFraction : null;
  const bankrollInvalid = bankrollText.trim() !== '' && num(bankrollText) == null;
  const canRegister = !!stake && houseOdds != null && houseOdds > 1;

  const registerBet = () => {
    if (!stake || houseOdds == null) return;
    register({
      selections: items.map(item => ({ match: item.match, market: item.market, selection: item.selection, probability: item.probability })),
      houseOdds, stake, probability: analysis.probability, evPct: analysis.evPct,
    });
    clear();
    setOddsText('');
    setStakeText('');
    setNotice('Apuesta registrada en el historial. Marca el resultado cuando se conozca.');
  };

  if (!items.length) {
    return <div className="fd-page">
      <h1 className="fd-title"><Ticket size={22} aria-hidden="true" /> Cupón</h1>
      {notice && <div className="notice" role="status" data-testid="status-slip-registered"><Check size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} /><span style={{ flex: 1 }}>{notice}</span><button className="icon-button" onClick={() => setNotice('')} aria-label="Cerrar aviso"><X size={14} /></button></div>}
      <section className="fd-card"><EmptyState title="Tu cupón está vacío" copy="Entra a un partido y pulsa «Cupón» en cualquier selección, o añade una value bet. Luego compara con la cuota de tu casa." action={<Link href="/matches" className="button primary">Ver partidos</Link>} /></section>
      <BankrollCard bankrollText={bankrollText} setBankrollText={onBankrollText} invalid={bankrollInvalid} />
      <HistorySection />
    </div>;
  }

  const evClass = analysis.hasValue ? 'good' : 'bad';
  return <div className="fd-page">
    <h1 className="fd-title"><Ticket size={22} aria-hidden="true" /> Cupón</h1>
    {items.map(item => <article className="fd-card fd-slip-item" key={item.id} data-testid={`slip-item-${item.id}`}>
      <div style={{ flex: 1 }}>
        <div className="fd-bet-match">{item.match}</div>
        <div className="fd-bet-title">{item.selection}</div>
        <div className="fd-bet-sub">{item.market}</div>
        <div className="fd-slip-stats"><span>Probabilidad <strong>{formatPct(item.probability)}</strong></span><span>Cuota justa <strong className="fd-cyan">{(1 / item.probability).toFixed(2)}</strong></span></div>
        <div className="fd-bet-sub">{item.source === 'blend' ? 'Probabilidad mezclada con el consenso del mercado' : 'Probabilidad del modelo puro'}</div>
      </div>
      <button className="icon-button" onClick={() => remove(item.id)} aria-label={`Quitar ${item.selection} del cupón`}><X size={18} aria-hidden="true" /></button>
    </article>)}

    <BankrollCard bankrollText={bankrollText} setBankrollText={onBankrollText} invalid={bankrollInvalid} />

    <section className="fd-card">
      <label className="fd-label" htmlFor="stake">Stake (importe a apostar)</label>
      <input id="stake" className="field fd-input" inputMode="decimal" placeholder="Ej: 10" value={stakeText} onChange={event => setStakeText(event.target.value)} data-testid="input-stake" />
      {suggestedStake != null && suggestedStake > 0 && <button type="button" className="button" style={{ marginTop: 10 }} onClick={() => setStakeText(suggestedStake.toFixed(2))} data-testid="button-use-suggested">Usar stake sugerido · {money(suggestedStake)}</button>}
    </section>

    <button className="button fd-clear" onClick={() => { clear(); setOddsText(''); }}><Trash2 size={14} aria-hidden="true" /> Limpiar todo</button>

    <section className="fd-card">
      <div className="fd-summary-top"><span>{items.length} {items.length === 1 ? 'selección' : 'selecciones'}</span><span>Prob. combinada: <strong className="fd-gold">{formatPct(analysis.probability, 2)}</strong></span></div>
      <div className="fd-label">Cuota justa</div>
      <div className="fd-fair">{Number.isFinite(analysis.fairOdds) ? analysis.fairOdds.toFixed(2) : '—'}</div>
      {analysis.sameMatch && <div className="notice" style={{ marginTop: 12 }}><AlertTriangle size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} /><span>Hay selecciones del mismo partido. La probabilidad combinada las multiplica como si fueran independientes y puede estar muy errada.</span></div>}
    </section>

    <section className="fd-card">
      <h2 className="fd-h">Comparar con la casa</h2>
      <input className="field fd-input" inputMode="decimal" placeholder="Cuota de la casa, ej: 1.50" value={oddsText} onChange={event => setOddsText(event.target.value)} aria-label="Cuota de la casa" data-testid="input-house-odds" />
      {oddsText !== '' && !num(oddsText) && <div className="fd-bet-sub" style={{ marginTop: 6 }}>Escribe una cuota decimal válida (mayor que 1).</div>}
      {analysis.evPct != null && <>
        <div className={`fd-result ${evClass}`}>
          <div className="fd-result-top">
            <div className="fd-result-ev">{analysis.evPct >= 0 ? '+' : ''}{analysis.evPct.toFixed(1)}%</div>
            <div className="fd-verdict">{analysis.hasValue ? <><Check size={14} aria-hidden="true" /> VALOR</> : <><X size={14} aria-hidden="true" /> SIN VALOR</>}</div>
          </div>
          <div className="fd-result-grid">
            <div><div className="fd-label">EV por 100</div><strong>{analysis.evPer100! >= 0 ? '+' : ''}{analysis.evPer100!.toFixed(2)}</strong></div>
            <div><div className="fd-label">Stake sugerido</div><strong className="fd-cyan">{analysis.suggestedFraction != null ? formatPct(analysis.suggestedFraction, 2) : '—'}{suggestedStake ? ` · ${money(suggestedStake)}` : ''}</strong></div>
            <div><div className="fd-label">Kelly completo</div><strong className="fd-muted">{analysis.fullKelly != null ? formatPct(analysis.fullKelly, 1) : '—'}</strong></div>
            {stake && <div><div className="fd-label">Ganancia esperada</div><strong>{money(stake * analysis.evPct / 100, true)}</strong></div>}
          </div>
        </div>
        <div className="fd-hint">
          <div>Hay valor si la casa ofrece <strong className="fd-good">más de {analysis.fairOdds.toFixed(2)}</strong></div>
          <div>No hay valor si ofrece <strong className="fd-bad">menos de {analysis.fairOdds.toFixed(2)}</strong></div>
        </div>
        {analysis.hasPureModel && analysis.prudentEvPct != null && <div className="fd-prudent">
          <div className="fd-label">EV prudente</div>
          <strong>{analysis.prudentEvPct >= 0 ? '+' : ''}{analysis.prudentEvPct.toFixed(1)}%</strong>
          <div className="fd-bet-sub">Mezcla 50/50 el modelo con la probabilidad que implica la cuota de la casa (margen supuesto del 5 %). Es el número más realista cuando la probabilidad viene del modelo puro.</div>
        </div>}
        {analysis.evPct > 20 && <div className="notice error" role="alert" style={{ marginTop: 12 }}><AlertTriangle size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} /><span>Un EV superior al 20 % casi siempre indica un error del modelo (lesiones, alineación) o una cuota errónea, no una oportunidad real. Verifica antes de apostar.</span></div>}
      </>}
      <button type="button" className="button primary fd-register" onClick={registerBet} disabled={!canRegister} data-testid="button-register-bet"><Save size={14} aria-hidden="true" /> Registrar apuesta</button>
      {!canRegister && <div className="fd-bet-sub" style={{ marginTop: 6 }}>Para registrarla escribe el stake y una cuota de la casa válida.</div>}
      <div className="fd-bet-sub" style={{ marginTop: 12 }}>El Kelly completo es muy agresivo y no se recomienda; el stake sugerido usa 25 % de Kelly con tope del 2 % de la banca. El EV positivo no garantiza acierto en una apuesta individual.</div>
    </section>

    <HistorySection />
  </div>;
}
