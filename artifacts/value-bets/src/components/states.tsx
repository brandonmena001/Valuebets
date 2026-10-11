import type { ReactNode } from 'react';
import { AlertCircle, FileSearch } from 'lucide-react';
import type { SourceState } from '@workspace/api-client-react';
import { statusNames } from '@/lib/labels';

/** Etiqueta de estado (partido o proveedor): punto de color + texto, nunca solo color. */
export function DataState({ state }: { state?: SourceState | string }) {
  const key = state ?? 'unconfigured';
  return <span className={`status ${key}`} data-testid={`status-${state ?? 'unknown'}`}>{statusNames[key] ?? key}</span>;
}

export function SkeletonBlock({ height = 100 }: { height?: number }) {
  return <div className="skeleton" style={{ height }} role="status" aria-busy="true" aria-label="Cargando datos" />;
}

/** Mensaje de error de carga; distingue «sin conexión» de un fallo del servidor. */
export function loadErrorMessage(what: string): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'Sin conexión a internet. Revisa tu red e inténtalo de nuevo.';
  }
  return `No se pudo cargar ${what}. El servidor puede estar temporalmente indisponible.`;
}

export function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="notice error" role="alert" data-testid="status-api-error">
    <AlertCircle size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
    <div style={{ flex: 1 }}>{message}</div>
    {retry && <button type="button" className="button" onClick={retry} data-testid="button-retry">Reintentar</button>}
  </div>;
}

export function EmptyState({ title, copy, action }: { title: string; copy: string; action?: ReactNode }) {
  return <div className="empty-state" data-testid="state-empty">
    <div className="empty-mark"><FileSearch size={18} aria-hidden="true" /></div>
    <div className="empty-title">{title}</div>
    <div className="empty-copy">{copy}</div>
    {action && <div style={{ marginTop: 14 }}>{action}</div>}
  </div>;
}

export function PageHeading({ eyebrow, title, note, action }: { eyebrow: string; title: string; note?: string; action?: ReactNode }) {
  return <div className="page-heading">
    <div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{note && <p className="heading-note">{note}</p>}</div>
    {action}
  </div>;
}
