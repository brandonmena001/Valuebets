import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Ticket, Trash2, X } from 'lucide-react';
import { Link } from 'wouter';
import { analyzeSlip, useSlip } from '@/lib/slip';

const pct = (value: number, decimals = 1) => `${new Intl.NumberFormat('es-CO', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value * 100)}%`;
const num = (value: string): number | null => {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export default function SlipPage() {
  const { items, remove, clear } = useSlip();
  const [oddsText, setOddsText] = useState('');
  const [stakeText, setStakeText] = useState('');
  const [bankrollText, setBankrollText] = useState('');
  const suggested = items.length === 1 ? items[0]?.houseOdds : null;
  const houseOdds = num(oddsText) ?? (oddsText === '' ? suggested ?? null : null);
  const analysis = useMemo(() => analyzeSlip(items, houseOdds), [items, houseOdds]);
  const stake = num(stakeText);
  const bankroll = num(bankrollText);

  if (!items.length) {
    return <div className="fd-page">
      <h1 className="fd-title"><Ticket size={22} /> Cupón</h1>
      <section className="fd-card"><div className="empty-state"><div className="empty-title">Tu cupón está vacío</div>
        <div className="empty-copy">Entra a un partido y pulsa «Cupón» en cualquier selección, o añade una value bet. Luego compara con la cuota de tu casa.</div>
        <Link href="/matches" className="button primary" style={{ marginTop: 12 }}>Ver partidos</Link></div></section>
    </div>;
  }

  const evClass = analysis.hasValue ? 'good' : 'bad';
  return <div className="fd-page">
    <h1 className="fd-title"><Ticket size={22} /> Cupón</h1>
    {items.map(item => <article className="fd-card fd-slip-item" key={item.id} data-testid={`slip-item-${item.id}`}>
      <div style={{ flex: 1 }}>
        <div className="fd-bet-match">{item.match}</div>
        <div className="fd-bet-title">{item.selection}</div>
        <div className="fd-bet-sub">{item.market}</div>
        <div className="fd-slip-stats"><span>Probabilidad <strong>{pct(item.probability)}</strong></span><span>Cuota justa <strong className="fd-cyan">{(1 / item.probability).toFixed(2)}</strong></span></div>
        <div className="fd-bet-sub">{item.source === 'blend' ? 'Probabilidad mezclada con el consenso del mercado' : 'Probabilidad del modelo puro'}</div>
      </div>
      <button className="icon-button" onClick={() => remove(item.id)} aria-label="Quitar selección"><X size={16} /></button>
    </article>)}

    <section className="fd-card">
      <label className="fd-label" htmlFor="stake">Stake (importe a apostar)</label>
      <input id="stake" className="field fd-input" inputMode="decimal" placeholder="Ej: 10" value={stakeText} onChange={event => setStakeText(event.target.value)} />
      <label className="fd-label" htmlFor="bankroll" style={{ marginTop: 12 }}>Banca total (opcional, para el stake sugerido)</label>
      <input id="bankroll" className="field fd-input" inputMode="decimal" placeholder="Ej: 500" value={bankrollText} onChange={event => setBankrollText(event.target.value)} />
    </section>

    <button className="button fd-clear" onClick={() => { clear(); setOddsText(''); }}><Trash2 size={14} /> Limpiar todo</button>

    <section className="fd-card">
      <div className="fd-summary-top"><span>{items.length} {items.length === 1 ? 'selección' : 'selecciones'}</span><span>Prob. combinada: <strong className="fd-gold">{pct(analysis.probability, 2)}</strong></span></div>
      <div className="fd-label">Cuota justa</div>
      <div className="fd-fair">{Number.isFinite(analysis.fairOdds) ? analysis.fairOdds.toFixed(2) : '—'}</div>
      {analysis.sameMatch && <div className="notice"><AlertTriangle size={15} /><span>Hay selecciones del mismo partido. La probabilidad combinada las multiplica como si fueran independientes y puede estar muy errada.</span></div>}
    </section>

    <section className="fd-card">
      <h2 className="fd-h">Comparar con la casa</h2>
      <input className="field fd-input" inputMode="decimal" placeholder="Cuota de la casa, ej: 1.50" value={oddsText} onChange={event => setOddsText(event.target.value)} aria-label="Cuota de la casa" data-testid="input-house-odds" />
      {oddsText !== '' && !num(oddsText) && <div className="fd-bet-sub" style={{ marginTop: 6 }}>Escribe una cuota decimal válida (mayor que 1).</div>}
      {analysis.evPct != null && <>
        <div className={`fd-result ${evClass}`}>
          <div className="fd-result-top">
            <div className="fd-result-ev">{analysis.evPct >= 0 ? '+' : ''}{analysis.evPct.toFixed(1)}%</div>
            <div className="fd-verdict">{analysis.hasValue ? <><Check size={14} /> VALOR</> : <><X size={14} /> SIN VALOR</>}</div>
          </div>
          <div className="fd-result-grid">
            <div><div className="fd-label">EV por 100</div><strong>{analysis.evPer100! >= 0 ? '+' : ''}{analysis.evPer100!.toFixed(2)}</strong></div>
            <div><div className="fd-label">Stake sugerido</div><strong className="fd-cyan">{analysis.suggestedFraction != null ? pct(analysis.suggestedFraction, 2) : '—'}{bankroll && analysis.suggestedFraction ? ` · ${(bankroll * analysis.suggestedFraction).toFixed(2)}` : ''}</strong></div>
            <div><div className="fd-label">Kelly completo</div><strong className="fd-muted">{analysis.fullKelly != null ? pct(analysis.fullKelly, 1) : '—'}</strong></div>
            {stake && <div><div className="fd-label">Ganancia esperada</div><strong>{(stake * analysis.evPct / 100).toFixed(2)}</strong></div>}
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
        {analysis.evPct > 20 && <div className="notice error" role="alert"><AlertTriangle size={15} /><span>Un EV superior al 20 % casi siempre indica un error del modelo (lesiones, alineación) o una cuota errónea, no una oportunidad real. Verifica antes de apostar.</span></div>}
      </>}
      <div className="fd-bet-sub" style={{ marginTop: 12 }}>El Kelly completo es muy agresivo y no se recomienda; el stake sugerido usa 25 % de Kelly con tope del 2 % de la banca. El EV positivo no garantiza acierto en una apuesta individual.</div>
    </section>
  </div>;
}
