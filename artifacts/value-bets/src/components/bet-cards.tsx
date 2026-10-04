import type { ValueBet } from '@workspace/api-client-react';
import { AddToSlip } from '@/components/add-to-slip';
import { slipItemId } from '@/lib/slip';

const leagues: Record<string, string> = { 'premier-league': 'Premier League', 'la-liga': 'LaLiga', bundesliga: 'Bundesliga' };
const confidenceNames = { high: 'Alta', medium: 'Media', low: 'Baja' } as const;

function pct(value: number, decimals = 1) {
  return `${new Intl.NumberFormat('es-CO', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value * 100)}%`;
}
function when(value: string) {
  return new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function BetCards({ bets, onSelect, showMatch = true }: { bets: ValueBet[]; onSelect?: (fixtureId: string) => void; showMatch?: boolean }) {
  if (!bets.length) {
    return <div className="empty-state" data-testid="state-empty">
      <div className="empty-title">Sin señales cualificadas</div>
      <div className="empty-copy">No hay apuestas de valor con los datos actuales. Es normal: los filtros del modelo son estrictos a propósito.</div>
    </div>;
  }
  return <div className="fd-bets">{bets.map(bet => {
    const implied = 1 / bet.decimalOdds;
    const label = bet.playerName ? `${bet.playerName} · ${bet.selection}` : bet.selection;
    const market = `${bet.marketName}${bet.line == null ? '' : ` ${bet.line}`}`;
    return <article key={bet.id} className="fd-bet" onClick={() => onSelect?.(bet.fixtureId)} style={{ cursor: onSelect ? 'pointer' : 'default' }} data-testid={`row-value-bet-${bet.id}`}>
      <div className="fd-bet-top">
        <div>
          {showMatch && <div className="fd-bet-match">{bet.homeTeam} vs {bet.awayTeam}</div>}
          <div className="fd-bet-title">{label}</div>
          <div className="fd-bet-sub">{market} · <span className="fd-chip">{bet.bookmaker}</span></div>
          {showMatch && <div className="fd-bet-sub">{leagues[bet.league] ?? bet.league} · {when(bet.kickoff)}</div>}
        </div>
        <div className="fd-bet-right">
          <div className="fd-label">Cuota</div>
          <div className="fd-odds">{bet.decimalOdds.toFixed(2)}</div>
          <span className="fd-ev">+{bet.expectedValuePct.toFixed(1)}%</span>
        </div>
      </div>
      <div className="fd-bar-row">
        <div className="fd-bar"><div className="fd-bar-fill" style={{ width: `${Math.min(100, bet.modelProbability * 100)}%` }} /><div className="fd-bar-mark" style={{ left: `${Math.min(100, implied * 100)}%` }} title="Probabilidad implícita de la cuota" /></div>
        <div className="fd-bar-copy"><strong>{pct(bet.modelProbability)}</strong> modelo · {pct(implied, 0)} cuota{bet.marketProbability != null && <> · {pct(bet.marketProbability, 0)} consenso</>}</div>
      </div>
      <div className="fd-bet-foot">
        <span className={`confidence ${bet.confidence}`}>Confianza {confidenceNames[bet.confidence]}</span>
        {bet.kellyFraction != null && bet.kellyFraction > 0 && <span className="fd-bet-sub">Stake sugerido {pct(bet.kellyFraction, 1)} de la banca</span>}
        <AddToSlip item={{ id: slipItemId(bet.fixtureId, market, label), fixtureId: bet.fixtureId, match: `${bet.homeTeam} vs ${bet.awayTeam}`, market, selection: label, probability: bet.modelProbability, source: 'blend', houseOdds: bet.decimalOdds }} />
      </div>
    </article>;
  })}</div>;
}
