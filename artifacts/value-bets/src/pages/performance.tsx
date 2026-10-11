import { AlertTriangle, Hourglass, Info, Scale, Target, TrendingUp } from 'lucide-react';
import { useGetModelPerformance } from '@workspace/api-client-react';
import type { PerformanceBucket } from '@workspace/api-client-react';
import { EmptyState, ErrorNotice, PageHeading, SkeletonBlock, loadErrorMessage } from '@/components/states';
import { formatDate, formatSigned, formatValue } from '@/lib/format';
import { marketNames } from '@/lib/labels';

/** Umbral que usa el servidor en su aviso de fiabilidad (~300 apuestas liquidadas). */
const SAMPLE_TARGET = 300;
/** Diferencia de Brier por debajo de la cual se habla de empate técnico. */
const BRIER_TIE = 0.0005;

type Verdict = { tone: 'good' | 'bad' | 'neutral'; text: string };

/** ROI ± 2 errores estándar ≈ intervalo del 95 %. Si incluye el 0 %, no se distingue de la suerte. */
function roiVerdict(bucket: PerformanceBucket): Verdict | null {
  const { roiPct, roiStdErrPct } = bucket;
  if (roiPct == null || roiStdErrPct == null || !(roiStdErrPct > 0)) return null;
  const low = roiPct - 2 * roiStdErrPct;
  const high = roiPct + 2 * roiStdErrPct;
  const range = `${formatSigned(low)}% a ${formatSigned(high)}%`;
  if (low > 0) return { tone: 'good', text: `Por encima del ruido: el intervalo aproximado del 95 % (${range}) no incluye el 0 %.` };
  if (high < 0) return { tone: 'bad', text: `Por debajo del ruido: el intervalo aproximado del 95 % (${range}) queda entero en pérdidas.` };
  return { tone: 'neutral', text: `Dentro del ruido: el intervalo aproximado del 95 % (${range}) incluye el 0 %, así que todavía no se distingue de la suerte.` };
}

function brierSummary(bucket: PerformanceBucket): string | null {
  const { brierModel, brierMarket } = bucket;
  if (brierModel == null || brierMarket == null) return null;
  const diff = brierModel - brierMarket;
  const small = bucket.bets < SAMPLE_TARGET ? ' Con tan pocas apuestas la diferencia puede ser ruido.' : '';
  if (Math.abs(diff) <= BRIER_TIE) return `Empate técnico con el mercado.${small}`;
  return diff < 0
    ? `El modelo predice mejor que el mercado (Brier ${formatValue(Math.abs(diff), 4)} menor).${small}`
    : `El mercado predice mejor que el modelo (Brier ${formatValue(diff, 4)} menor para el mercado).${small}`;
}

function BrierBars({ bucket }: { bucket: PerformanceBucket }) {
  const rows = [
    { key: 'model', label: 'Modelo (mezclado con el mercado)', value: bucket.brierModel },
    { key: 'raw', label: 'Modelo puro', value: bucket.brierRaw },
    { key: 'market', label: 'Mercado (consenso)', value: bucket.brierMarket },
  ];
  const max = Math.max(0.25, ...rows.map(row => row.value ?? 0));
  return <div className="perf-brier" data-testid="perf-brier">
    {rows.map(row => <div className="perf-brier-row" key={row.key}>
      <div className="perf-brier-head"><span>{row.label}</span><strong className="mono">{formatValue(row.value, 4)}</strong></div>
      <div className="fd-bar" role="img" aria-label={`${row.label}: Brier ${formatValue(row.value, 4)}`}>
        <div className={`fd-bar-fill perf-brier-${row.key}`} style={{ width: `${row.value == null ? 0 : Math.min(100, (row.value / max) * 100)}%` }} />
      </div>
    </div>)}
  </div>;
}

function PerfMetric({ label, value, foot, icon: Icon, tone }: { label: string; value: string; foot: string; icon: typeof Target; tone?: 'good' | 'bad' }) {
  return <div className="panel metric perf-metric" data-testid={`perf-metric-${label.toLowerCase().replaceAll(' ', '-')}`}>
    <div className="metric-label">{label}</div>
    <div className={`metric-value ${tone ? `perf-${tone}` : ''}`}>{value}</div>
    <div className="metric-foot"><Icon size={12} aria-hidden="true" style={{ verticalAlign: 'middle', marginRight: 5 }} />{foot}</div>
  </div>;
}

function MarketCard({ category, bucket }: { category: string; bucket: PerformanceBucket }) {
  const verdict = roiVerdict(bucket);
  return <article className="fd-card perf-market" data-testid={`perf-market-${category}`}>
    <div className="perf-market-head"><h3 className="fd-h" style={{ margin: 0 }}>{marketNames[category] ?? category}</h3><span className="fd-chip">{bucket.bets} {bucket.bets === 1 ? 'apuesta' : 'apuestas'}</span></div>
    <div className="perf-market-grid">
      <div><div className="fd-label">ROI</div><strong className={`mono ${verdict ? `perf-${verdict.tone}` : ''}`}>{formatSigned(bucket.roiPct)}%{bucket.roiStdErrPct != null && <> ± {formatValue(bucket.roiStdErrPct)}</>}</strong></div>
      <div><div className="fd-label">CLV medio</div><strong className="mono">{formatSigned(bucket.avgClvPct)}%</strong></div>
      <div><div className="fd-label">Acierto</div><strong className="mono">{formatValue(bucket.hitRatePct)}%</strong></div>
      <div><div className="fd-label">Brier modelo / mercado</div><strong className="mono">{formatValue(bucket.brierModel, 3)} / {formatValue(bucket.brierMarket, 3)}</strong></div>
    </div>
  </article>;
}

export default function PerformancePage() {
  const { data, isLoading, isError, refetch } = useGetModelPerformance();
  const overall = data?.overall;
  const settled = overall?.bets ?? 0;
  const verdict = overall ? roiVerdict(overall) : null;
  const markets = Object.entries(data?.byMarket ?? {}).sort((a, b) => b[1].bets - a[1].bets);
  const progress = Math.min(100, (settled / SAMPLE_TARGET) * 100);
  const brierText = overall ? brierSummary(overall) : null;

  return <div className="fd-page">
    <PageHeading eyebrow="Evidencia · apuestas liquidadas" title="Rendimiento" note="Lo que el modelo ha ganado o perdido de verdad, sin maquillaje." />

    {isError && <ErrorNotice message={loadErrorMessage('el rendimiento del modelo')} retry={() => { void refetch(); }} />}
    {isLoading && <div className="perf-skeletons"><SkeletonBlock height={120} /><div className="metric-grid"><SkeletonBlock height={98} /><SkeletonBlock height={98} /><SkeletonBlock height={98} /><SkeletonBlock height={98} /></div><SkeletonBlock height={190} /></div>}

    {data && overall && <>
      <section className={`notice perf-reliability ${settled < SAMPLE_TARGET ? '' : 'ok'}`} data-testid="perf-reliability">
        {settled < SAMPLE_TARGET ? <AlertTriangle size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} /> : <Info size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />}
        <div style={{ flex: 1 }}>
          <strong>Fiabilidad de la muestra</strong>
          <div>{data.reliability}</div>
          <div className="perf-progress" role="img" aria-label={`${settled} de ${SAMPLE_TARGET} apuestas liquidadas`}><div style={{ width: `${progress}%` }} /></div>
          <div className="perf-progress-copy mono">{settled} / {SAMPLE_TARGET} liquidadas · {data.pending} pendientes</div>
        </div>
      </section>

      {settled === 0 ? <section className="fd-card"><EmptyState title="Aún no hay apuestas liquidadas" copy={data.pending > 0
        ? `Hay ${data.pending} apuestas registradas esperando que terminen sus partidos. Los resultados aparecerán aquí al liquidarse.`
        : 'Cuando el modelo registre apuestas y sus partidos terminen, aquí verás ROI, CLV y Brier reales.'} /></section> : <>
        <div className="metric-grid perf-grid">
          <PerfMetric label="ROI" value={`${formatSigned(overall.roiPct)}%`} tone={verdict?.tone === 'good' ? 'good' : verdict?.tone === 'bad' ? 'bad' : undefined}
            foot={overall.roiStdErrPct == null ? 'Error estándar no disponible' : `± ${formatValue(overall.roiStdErrPct)} (error estándar)`} icon={TrendingUp} />
          <PerfMetric label="CLV medio" value={`${formatSigned(overall.avgClvPct)}%`} foot="Tu cuota vs. la de cierre" icon={Target} tone={overall.avgClvPct == null ? undefined : overall.avgClvPct > 0 ? 'good' : overall.avgClvPct < 0 ? 'bad' : undefined} />
          <PerfMetric label="Acierto" value={`${formatValue(overall.hitRatePct)}%`} foot={`${overall.wins} de ${overall.bets} · cuota media ${formatValue(overall.avgOdds, 2)}`} icon={Scale} />
          <PerfMetric label="Pendientes" value={String(data.pending)} foot="Esperando resultado" icon={Hourglass} />
        </div>

        {verdict && <div className={`notice perf-verdict ${verdict.tone}`} data-testid="perf-verdict"><Info size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} /><span>{verdict.text}</span></div>}

        <section className="fd-card">
          <h2 className="fd-h">Brier: modelo vs. mercado</h2>
          <BrierBars bucket={overall} />
          {brierText && <div className="perf-brier-note" data-testid="perf-brier-summary">{brierText}</div>}
          <div className="fd-bet-sub" style={{ marginTop: 10 }}>Menor es mejor. Se calcula solo sobre las apuestas que el modelo recomendó, no sobre todos los partidos, así que no es una comparación general.</div>
        </section>

        {markets.length > 0 && <section>
          <h2 className="fd-h" style={{ margin: '4px 0 10px' }}>Por mercado</h2>
          <div className="perf-markets">{markets.map(([category, bucket]) => <MarketCard key={category} category={category} bucket={bucket} />)}</div>
        </section>}
      </>}

      <div className="footer-note">Datos generados: {formatDate(data.generatedAt, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} (hora de Bogotá). El CLV es aproximado: usa la última cuota registrada antes del inicio. Las apuestas nulas no cuentan. Resultados pasados no garantizan resultados futuros.</div>
    </>}
  </div>;
}
