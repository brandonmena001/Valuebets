import { Check, Plus } from 'lucide-react';
import { useSlip, type SlipItem } from '@/lib/slip';

export function AddToSlip({ item, compact = false }: { item: SlipItem; compact?: boolean }) {
  const { has, add, remove } = useSlip();
  const active = has(item.id);
  return <button
    type="button"
    className={`fd-add ${active ? 'active' : ''} ${compact ? 'compact' : ''}`}
    onClick={event => { event.stopPropagation(); if (active) remove(item.id); else add(item); }}
    aria-pressed={active}
    aria-label={`${active ? 'Quitar del cupón' : 'Añadir al cupón'}: ${item.selection} (${item.market})`}
    data-testid={`button-slip-${item.id}`}
  >{active ? <Check size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}{!compact && <span>{active ? 'En cupón' : 'Cupón'}</span>}</button>;
}
