import type { LineProbability } from '@workspace/api-client-react';
import { AddToSlip } from '@/components/add-to-slip';
import { formatFairOdds, formatPct } from '@/lib/format';
import { slipItemId } from '@/lib/slip';

/**
 * Bloques reutilizables para mostrar un mercado del modelo con su botón de cupón.
 * Cualquier mercado nuevo (hándicap, etc.) se monta con estas piezas sin tocar el cupón:
 * el cupón solo necesita mercado, selección y probabilidad.
 */

export type Pick = { market: string; selection: string; probability: number };

export function PickRow({ fixtureId, match, pick, label }: { fixtureId: string; match: string; pick: Pick; label?: string }) {
  return <div className="fd-pick">
    <div><div className="fd-pick-name">{label ?? pick.selection}</div><div className="fd-bet-sub">Cuota justa {formatFairOdds(pick.probability)}</div></div>
    <div className="fd-pick-right"><strong>{formatPct(pick.probability)}</strong>
      <AddToSlip compact item={{ id: slipItemId(fixtureId, pick.market, pick.selection), fixtureId, match, market: pick.market, selection: pick.selection, probability: pick.probability, source: 'model' }} />
    </div>
  </div>;
}

type LineTableProps = {
  fixtureId: string;
  match: string;
  market: string;
  lines: LineProbability[];
  /** Nombres de las dos columnas; por defecto Más / Menos. `over` es la probabilidad de la primera. */
  sides?: readonly [string, string];
  /** Texto de la selección que se guarda en el cupón. */
  selectionLabel?: (side: string, line: number) => string;
};

export function LineTable({ fixtureId, match, market, lines, sides = ['Más', 'Menos'], selectionLabel = (side, line) => `${side} de ${line}` }: LineTableProps) {
  return <div className="fd-lines">
    <div className="fd-lines-head"><span>Línea</span><span>{sides[0]}</span><span>{sides[1]}</span></div>
    {lines.map(({ line, over }) => <div className="fd-lines-row" key={line}>
      <span className="mono">{line}</span>
      {([[sides[0], over], [sides[1], 1 - over]] as const).map(([side, probability]) => <span className="fd-lines-cell" key={side}>
        <em>{formatPct(probability, 0)}</em>
        <AddToSlip compact item={{ id: slipItemId(fixtureId, `${market} ${line}`, side), fixtureId, match, market: `${market} ${line}`, selection: selectionLabel(side, line), probability, source: 'model' }} />
      </span>)}
    </div>)}
  </div>;
}
