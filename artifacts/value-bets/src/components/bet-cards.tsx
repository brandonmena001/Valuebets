import type { ValueBet } from '@workspace/api-client-react';
import { AddToSlip } from '@/components/add-to-slip';
import { formatDate, formatPct } from '@/lib/format';
import { confidenceNames, leagues } from '@/lib/labels';
import { slipItemId } from '@/lib/slip';

export function BetCards({ bets, onSelect, showMatch = true }: { bets: ValueBet[]; onSelect?: (fixtureId: string) => void; showMatch?: boolean }) {
  if (!bets.length) {
    return <div className="empty-state" data-testid="state-empty">
      <div className="empty-title">Sin señales cualificadas</div>
      <div className="empty-copy">No hay diferencias de precio relevantes con los datos actuales. Es lo normal: el mercado 1X2 es muy eficiente y los filtros son estrictos a propósito.</div>
    </div>;
  }
  const referenceMode = bets.some(bet => bet.modelVersion.startsWith('ref-'));
  return <>
    {referenceMode && <div className="notice" role="note" style={{ margin: '0 0 10px' }}><span><strong>Señales de precio, no ventaja demostrada.</strong> Cada cuota se compara con el consenso de las demás casas. En el backtest (5 ligas, unos 5 600 partidos) esa comparación no superó al cierre de Pinnacle (CLV ≈ 0) y el modelo estadístico empeoraba al mercado, por eso no interviene. Úsalas para encontrar el mejor precio, no como garantía, y verifica la cuota en la casa antes de apostar.</span></div>}
    <div className="fd-bets">{bets.map(bet => {
    const ref = bet.modelVersion.startsWith('ref-');
    const implied = 1 / bet.decimalOdds;
    const label = bet.playerName ? `${bet.playerName} · ${bet.selection}` : bet.selection;
    const market = `${bet.marketName}${bet.line == null ? '' : ` ${bet.line}`}`;
    const matchLabel = `${bet.homeTeam} vs ${bet.awayTeam}`;
    return <article key={bet.id} className="fd-bet" onClick={() => onSelect?.(bet.fixtureId)} style={{ cursor: onSelect ? 'pointer' : 'default' }} data-testid={`row-value-bet-${bet.id}`}>
      <div className="fd-bet-top">
        <div>
          {showMatch && (onSelect
            ? <button type="button" className="fd-bet-link" onClick={event => { event.stopPropagation(); onSelect(bet.fixtureId); }} aria-label={`Ver análisis de ${matchLabel}`}>{matchLabel}</button>
            : <div className="fd-bet-match">{matchLabel}</div>)}
          <div className="fd-bet-title">{label}</div>
          <div className="fd-bet-sub">{market} · <span className="fd-chip">{bet.bookmaker}</span></div>
          {showMatch && <div className="fd-bet-sub">{leagues[bet.league] ?? bet.league} · {formatDate(bet.kickoff)}</div>}
        </div>
        <div className="fd-bet-right">
          <div className="fd-label">Cuota</div>
          <div className="fd-odds">{bet.decimalOdds.toFixed(2)}</div>
          <span className="fd-ev">+{bet.expectedValuePct.toFixed(1)}%{ref ? ' vs consenso' : ''}</span>
        </div>
      </div>
      <div className="fd-bar-row">
        <div className="fd-bar" role="img" aria-label={`${ref ? 'Consenso' : 'Modelo'} ${formatPct(bet.modelProbability)}, cuota implica ${formatPct(implied, 0)}`}><div className="fd-bar-fill" style={{ width: `${Math.min(100, bet.modelProbability * 100)}%` }} /><div className="fd-bar-mark" style={{ left: `${Math.min(100, implied * 100)}%` }} title="Probabilidad implícita de la cuota" /></div>
        <div className="fd-bar-copy">{ref
          ? <><strong>{formatPct(bet.modelProbability)}</strong> consenso de las demás casas · {formatPct(implied, 0)} cuota</>
          : <><strong>{formatPct(bet.modelProbability)}</strong> modelo · {formatPct(implied, 0)} cuota{bet.marketProbability != null && <> · {formatPct(bet.marketProbability, 0)} consenso</>}</>}</div>
      </div>
      <div className="fd-bet-foot">
        <span className={`confidence ${bet.confidence}`}>Confianza {confidenceNames[bet.confidence]}</span>
        {bet.kellyFraction != null && bet.kellyFraction > 0 && <span className="fd-bet-sub">Stake sugerido {formatPct(bet.kellyFraction, 1)} de la banca</span>}
        <AddToSlip item={{ id: slipItemId(bet.fixtureId, market, label), fixtureId: bet.fixtureId, match: matchLabel, market, selection: label, probability: bet.modelProbability, source: 'blend', houseOdds: bet.decimalOdds }} />
      </div>
    </article>;
  })}</div>
  </>;
}
