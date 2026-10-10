import { Compass } from 'lucide-react';
import { Link } from 'wouter';
import { EmptyState } from '@/components/states';

export default function NotFound() {
  return <div className="fd-page">
    <section className="fd-card" data-testid="page-not-found">
      <EmptyState
        title="Página no encontrada"
        copy="La dirección no existe o ya no está disponible."
        action={<Link href="/" className="button primary"><Compass size={14} aria-hidden="true" /> Ir al resumen</Link>}
      />
    </section>
  </div>;
}
