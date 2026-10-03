import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Activity, AlertCircle, ArrowUpRight, CalendarClock, ChartNoAxesCombined,
  Check, ChevronRight, CircleDot, Database, FileSearch, Gauge, RefreshCw,
  Search, ShieldCheck, Signal, Sparkles, X,
} from 'lucide-react';
import {
  getGetDashboardSummaryQueryKey, getGetMatchesQueryKey, getGetSourceStatusQueryKey,
  getGetValueBetsQueryKey, getGetMatchDetailQueryKey, useGetDashboardSummary,
  useGetMatches, useGetMatchDetail, useGetSourceStatus, useGetValueBets, useRequestDataSync,
} from '@workspace/api-client-react';
import type {
  GetMatchesParams, MatchSummary, Provider,
  SourceHealth, SourceState, ValueBet,
} from '@workspace/api-client-react';
import { Link, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 20_000, retry: 1, refetchOnWindowFocus: false } },
});

const leagues: Record<string, string> = {
  'premier-league': 'Premier League',
  'la-liga': 'LaLiga',
  bundesliga: 'Bundesliga',
};
const marketNames: Record<string, string> = {
  'match-result': '1X2', goals: 'Goles', corners: 'Córners', cards: 'Tarjetas',
  'shots-on-target': 'Tiros a puerta',
};
const providerNames: Record<string, string> = { 'api-football': 'API-Football', oddspapi: 'OddsPapi' };
const statusNames: Record<string, string> = {
  scheduled: 'Programado', live: 'En directo', finished: 'Finalizado',
  postponed: 'Aplazado', cancelled: 'Cancelado', unknown: 'Sin estado',
  ok: 'Operativo', partial: 'Cobertura parcial', stale: 'Datos desactualizados',
  waiting: 'En espera', error: 'Error', unconfigured: 'Sin configurar',
};

function formatDate(value?: string | null, options?: Intl.DateTimeFormatOptions) {
  if (!value) return 'Sin datos';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Fecha no disponible';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    ...(options ?? { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
  }).format(date);
}
function formatValue(value: number | null | undefined, decimals = 1) {
  return value == null || !Number.isFinite(value)
    ? '—'
    : new Intl.NumberFormat('es-CO', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
}
function stateClass(state?: string) {
  return `status ${state ?? 'unconfigured'}`;
}
function DataState({ state }: { state?: SourceState }) {
  return <span className={stateClass(state)} data-testid={`status-${state ?? 'unknown'}`}>{statusNames[state ?? 'unconfigured'] ?? state}</span>;
}
function SkeletonBlock({ height = 100 }: { height?: number }) {
  return <div className="skeleton" style={{ height }} aria-label="Cargando datos" />;
}
function ErrorNotice({ message, retry }: { message: string; retry: () => void }) {
  return <div className="notice error" role="alert" data-testid="status-api-error">
    <AlertCircle size={16} /><div style={{ flex: 1 }}>{message}</div>
    <button className="button" onClick={retry} data-testid="button-retry">Reintentar</button>
  </div>;
}
function EmptyState({ title, copy }: { title: string; copy: string }) {
  return <div className="empty-state" data-testid="state-empty">
    <div className="empty-mark"><FileSearch size={18} /></div>
    <div className="empty-title">{title}</div><div className="empty-copy">{copy}</div>
  </div>;
}
function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const active = location === '/' ? 'overview' : location.slice(1);
  const [clock, setClock] = useState(new Date());
  const { data: sourceStatus } = useGetSourceStatus();
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const states = sourceStatus?.sources?.map(source => source.state) ?? [];
  const overallState = !sourceStatus || !states.length
    ? 'waiting'
    : states.some(state => state === 'error' || state === 'unconfigured')
      ? 'error'
      : states.some(state => state === 'partial' || state === 'stale')
        ? 'partial'
        : states.every(state => state === 'ok')
          ? 'ok'
          : 'waiting';
  const overallLabel = overallState === 'ok'
    ? 'Fuentes operativas'
    : overallState === 'partial'
      ? 'Cobertura parcial'
      : overallState === 'error'
        ? 'Atención requerida'
        : 'Verificando fuentes';
  const nav = [
    { href: '/', label: 'Resumen', icon: ChartNoAxesCombined, id: 'overview' },
    { href: '/matches', label: 'Partidos', icon: Activity, id: 'matches' },
    { href: '/sources', label: 'Fuentes', icon: Database, id: 'sources' },
  ];
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><ChartNoAxesCombined size={18} /></div>
        <div><div className="brand-name">Value Bets</div><div className="brand-caption">Análisis de fútbol</div></div>
      </div>
      <div className="nav-label">Observatorio</div>
      <nav aria-label="Navegación principal">
        {nav.map(({ href, label, icon: Icon, id }) => <Link key={href} href={href} className={`nav-link ${active === id ? 'active' : ''}`} data-testid={`link-${id}`}>
          <Icon size={16} strokeWidth={1.8} /><span>{label}</span>
        </Link>)}
      </nav>
      <div className="side-bottom">
        <div className="provider-mini">
          <div className="provider-mini-head"><span>Proveedores</span><Signal size={12} /></div>
          <ProviderMini provider="api-football" />
          <ProviderMini provider="oddspapi" />
        </div>
      </div>
    </aside>
    <div className="main-area">
      <header className="topbar">
        <div className="breadcrumb">Análisis <ChevronRight size={12} style={{ verticalAlign: 'middle', margin: '0 4px' }} /><strong>{nav.find(n => n.id === active)?.label ?? 'Resumen'}</strong></div>
        <div className="topbar-right"><span data-testid="status-system"><span className="signal-dot" style={{ background: overallState === 'ok' ? 'hsl(var(--primary))' : overallState === 'partial' || overallState === 'error' ? 'hsl(var(--destructive))' : 'hsl(var(--muted-foreground))' }} />{overallLabel}</span><span className="mono">{new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' }).format(clock)}</span></div>
      </header>
      <main className="content fade-up">{children}</main>
    </div>
  </div>;
}
function ProviderMini({ provider }: { provider: string }) {
  const { data } = useGetSourceStatus();
  const health = data?.sources?.find(source => source.provider === provider);
  return <div className="provider-mini-row" data-testid={`provider-mini-${provider}`}>
    <span>{providerNames[provider] ?? provider}</span><DataState state={health?.state} />
  </div>;
}

function PageHeading({ eyebrow, title, note, action }: { eyebrow: string; title: string; note?: string; action?: ReactNode }) {
  return <div className="page-heading">
    <div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{note && <p className="heading-note">{note}</p>}</div>
    {action}
  </div>;
}

function Metric({ label, value, foot, icon: Icon }: { label: string; value: ReactNode; foot: string; icon: typeof Gauge }) {
  return <div className="panel metric" data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}>
    <div className="metric-label">{label}</div><div className="metric-value">{value}</div>
    <div className="metric-foot"><Icon size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />{foot}</div>
  </div>;
}
function BetRows({ bets, onSelect }: { bets: ValueBet[]; onSelect: (fixtureId: string) => void }) {
  if (!bets.length) return <EmptyState title="Sin señales cualificadas" copy="No hay apuestas de valor disponibles con los datos actuales del modelo." />;
  return <div className="table-wrap"><table className="bet-table">
    <thead><tr><th>Encuentro / liga</th><th>Mercado</th><th>Cuota</th><th>Prob. modelo</th><th>Valor esperado</th><th>Confianza</th></tr></thead>
    <tbody>{bets.map(bet => <tr className="bet-row" key={bet.id} onClick={() => onSelect(bet.fixtureId)} data-testid={`row-value-bet-${bet.id}`} style={{ cursor: 'pointer' }}>
      <td><div className="team-pair">{bet.homeTeam} <span style={{ color: 'hsl(var(--muted-foreground))' }}>—</span> {bet.awayTeam}</div><div className="subline">{leagues[bet.league] ?? bet.league} · {formatDate(bet.kickoff, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</div></td>
      <td><div>{bet.selection}</div>{bet.playerName && <div className="subline">Jugador · {bet.playerName}</div>}<div className="subline">{bet.marketName}{bet.line == null ? '' : ` · ${bet.line}`}</div></td>
      <td><span className="mono">{formatValue(bet.decimalOdds, 2)}</span><div className="subline">{bet.bookmaker}</div></td>
      <td className="mono">{formatValue(bet.modelProbability * 100, 1)}%</td>
      <td><span className="ev-pill">{bet.expectedValuePct > 0 ? '+' : ''}{formatValue(bet.expectedValuePct, 1)}%</span></td>
      <td><span className={`confidence ${bet.confidence}`}>{bet.confidence === 'high' ? 'Alta' : bet.confidence === 'medium' ? 'Media' : 'Baja'}</span></td>
    </tr>)}</tbody>
  </table></div>;
}

function DashboardPage() {
  const { data: summary, isLoading, isError, refetch } = useGetDashboardSummary();
  const betsQuery = useGetValueBets();
  const sourceQuery = useGetSourceStatus();
  const [selected, setSelected] = useState<string | null>(null);
  const bets = betsQuery.data ?? summary?.topValueBets ?? [];
  const shownBets = summary?.topValueBets?.length ? summary.topValueBets : bets;
  const allSourceOk = sourceQuery.data?.sources?.every(source => source.state === 'ok');
  return <>
    <PageHeading eyebrow="Panel de observación · fútbol europeo" title="Resumen" note="Lectura rápida de actividad, señales y calidad del dato." action={
      <Link href="/sources" className="button"><RefreshCw size={13} /> Estado de datos <ChevronRight size={13} /></Link>
    } />
    {isError && <ErrorNotice message="No se ha podido cargar el resumen del servidor. Comprueba la conexión con la API." retry={() => { void refetch(); }} />}
    {sourceQuery.data?.sources?.some(source => source.state === 'partial' || source.state === 'stale') &&
      <div className="notice"><AlertCircle size={15} /><span>La cobertura de las fuentes es parcial o contiene datos desactualizados. Las señales deben interpretarse con cautela.</span></div>}
    {isLoading ? <div className="metric-grid">{[0, 1, 2, 3].map(i => <SkeletonBlock key={i} height={108} />)}</div> : summary && <>
      <div className="metric-grid">
        <Metric label="Próximos partidos" value={summary.upcomingMatches} foot="En seguimiento" icon={CalendarClock} />
        <Metric label="Partidos en directo" value={summary.liveMatches} foot="Ahora mismo" icon={CircleDot} />
        <Metric label="Value bets" value={summary.valueBetsCount} foot="Cualificadas por modelo" icon={Sparkles} />
        <Metric label="EV medio" value={summary.averageEvPct == null ? '—' : `${formatValue(summary.averageEvPct)}%`} foot="Sobre señales activas" icon={ArrowUpRight} />
      </div>
      <div className="dash-grid">
        <section className="panel">
          <div className="section-head"><div><div className="section-kicker">Señales del modelo</div><div className="section-title">Value bets destacadas</div></div>
            <Link href="/matches" className="button">Ver calendario <ChevronRight size={13} /></Link>
          </div>
          {betsQuery.isError && <ErrorNotice message="No se pudieron cargar las señales del mercado." retry={() => { void betsQuery.refetch(); }} />}
          {betsQuery.isLoading && !summary ? <div style={{ padding: 18 }}><SkeletonBlock height={210} /></div> :
            <BetRows bets={shownBets} onSelect={setSelected} />}
        </section>
        <section className="panel signal-panel">
          <div className="section-head"><div><div className="section-kicker">Integridad de datos</div><div className="section-title">Señal de origen</div></div><ShieldCheck size={17} color="hsl(var(--primary))" /></div>
          <div className="signal-copy">
            {allSourceOk === undefined ? 'Estado de proveedores pendiente de respuesta.' : allSourceOk
              ? 'Los proveedores informan de estado operativo. La cobertura sigue sujeta a disponibilidad por competición y mercado.'
              : 'Hay proveedores con cobertura limitada, estado desactualizado o incidencias reportadas.'}
          </div>
          {sourceQuery.data?.sources?.length ? sourceQuery.data.sources.map(source => <div className="source-line" key={source.provider}>
            <div className="source-name"><span className="provider-icon">{source.provider === 'oddspapi' ? 'OP' : 'AF'}</span>{providerNames[source.provider] ?? source.provider}</div>
            <DataState state={source.state} />
          </div>) : sourceQuery.isLoading ? <div style={{ padding: '8px 19px' }}><SkeletonBlock height={62} /></div> :
            <div className="source-line"><span className="subline">Estado de fuentes no disponible</span><button className="icon-button" onClick={() => void sourceQuery.refetch()} aria-label="Reintentar estado"><RefreshCw size={14} /></button></div>}
          <div className="freshness">
            <div className="fresh-cell"><div className="fresh-title">Última cuota</div><div className="fresh-time">{formatDate(summary.latestOddsSync)}</div><div className="fresh-state">Sincronización OddsPapi</div></div>
            <div className="fresh-cell"><div className="fresh-title">Última estadística</div><div className="fresh-time">{formatDate(summary.latestStatsSync)}</div><div className="fresh-state">Sincronización API-Football</div></div>
          </div>
          <div style={{ padding: '0 18px' }}><div className="fresh-title">Datos generados</div><div className="fresh-time">{formatDate(summary.generatedAt, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div></div>
        </section>
      </div>
    </>}
    {!isLoading && !summary && !isError && <div className="panel"><EmptyState title="Esperando datos del servidor" copy="El resumen aparecerá cuando la API publique una respuesta." /></div>}
    {selected && <MatchDetailModal fixtureId={selected} onClose={() => setSelected(null)} />}
  </>;
}

function MatchPage() {
  const [league, setLeague] = useState('');
  const [status, setStatus] = useState('');
  const [days, setDays] = useState('7');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const params = useMemo<GetMatchesParams>(() => ({
    ...(league ? { league: league as GetMatchesParams['league'] } : {}),
    ...(status ? { status: status as GetMatchesParams['status'] } : {}),
    ...(days ? { days: Number(days) } : {}),
  }), [league, status, days]);
  const { data, isLoading, isError, refetch, isFetching } = useGetMatches(params);
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es');
    return (data ?? []).filter(match => !term || `${match.homeTeam} ${match.awayTeam} ${match.country} ${leagues[match.league] ?? match.league}`.toLocaleLowerCase('es').includes(term));
  }, [data, search]);
  return <>
    <PageHeading eyebrow="Competiciones · fixtures · cobertura" title="Partidos" note="Partidos seguidos y mercados disponibles en las fuentes conectadas." action={<button className="button" onClick={() => void refetch()} disabled={isFetching} data-testid="button-refresh-matches"><RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} /> Actualizar</button>} />
    <div className="panel filters">
      <span className="filter-label">Filtrar</span>
      <label className="search-field"><Search size={14} /><input className="field" type="search" placeholder="Equipo o competición" value={search} onChange={event => setSearch(event.target.value)} aria-label="Buscar equipo o competición" data-testid="input-match-search" /></label>
      <select className="select" value={league} onChange={event => setLeague(event.target.value)} aria-label="Filtrar por liga" data-testid="select-match-league">
        <option value="">Todas las ligas</option><option value="premier-league">Premier League</option><option value="la-liga">LaLiga</option><option value="bundesliga">Bundesliga</option>
      </select>
      <select className="select" value={status} onChange={event => setStatus(event.target.value)} aria-label="Filtrar por estado" data-testid="select-match-status">
        <option value="">Todos los estados</option><option value="scheduled">Programado</option><option value="live">En directo</option><option value="finished">Finalizado</option>
      </select>
      <select className="select" value={days} onChange={event => setDays(event.target.value)} aria-label="Ventana temporal" data-testid="select-match-days">
        <option value="1">Próximo día</option><option value="3">3 días</option><option value="7">7 días</option><option value="14">14 días</option><option value="30">30 días</option>
      </select>
    </div>
    {isError && <ErrorNotice message="No se pudo obtener el calendario. El servidor puede estar temporalmente indisponible." retry={() => { void refetch(); }} />}
    {isLoading ? <div className="match-list">{[0, 1, 2, 3].map(i => <SkeletonBlock key={i} height={96} />)}</div> :
      filtered.length ? <div className="match-list" data-testid="list-matches">{filtered.map(match => <MatchCard key={match.fixtureId} match={match} onClick={() => setSelected(match.fixtureId)} />)}</div> :
      !isError && <div className="panel"><EmptyState title={search ? 'No hay coincidencias' : 'No hay partidos en este periodo'} copy={search ? 'Prueba con otro nombre o cambia los filtros.' : 'La API no ha devuelto fixtures para los filtros seleccionados.'} /></div>}
    {data && <div className="footer-note">Mostrando {filtered.length} de {data.length} partidos devueltos por la API{isFetching ? ' · actualizando' : ''}. La cobertura corresponde a mercados recibidos, no a disponibilidad garantizada.</div>}
    {selected && <MatchDetailModal fixtureId={selected} onClose={() => setSelected(null)} />}
  </>;
}
function MatchCard({ match, onClick }: { match: MatchSummary; onClick: () => void }) {
  return <button className="panel match-card" onClick={onClick} data-testid={`card-match-${match.fixtureId}`} style={{ textAlign: 'left', color: 'inherit' }}>
    <div><div className="match-league">{leagues[match.league] ?? match.league} · {match.country}</div><div className="match-title">{match.homeTeam}<span style={{ color: 'hsl(var(--muted-foreground))', margin: '0 7px' }}>—</span>{match.awayTeam}</div></div>
    <div><div className="coverage-label">Inicio / estado</div><div className="match-time">{match.status === 'live' && match.homeScore != null ? <span className="match-score">{match.homeScore} : {match.awayScore ?? '—'}</span> : null}<DataState state={match.status as SourceState} /></div><div className="subline">{formatDate(match.kickoff)}</div></div>
    <div><div className="coverage-label">Mercados disponibles · {match.availableMarkets.length}</div><div className="market-chips">{match.availableMarkets.length ? match.availableMarkets.map(market => <span className="market-chip" key={market}>{marketNames[market] ?? market}</span>) : <span className="subline">Sin cobertura reportada</span>}</div></div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><div className="subline">Act. {formatDate(match.lastUpdatedAt, { hour: '2-digit', minute: '2-digit' })}</div><ChevronRight size={15} color="hsl(var(--muted-foreground))" /></div>
  </button>;
}

function MatchDetailModal({ fixtureId, onClose }: { fixtureId: string; onClose: () => void }) {
  const { data, isLoading, isError, refetch } = useGetMatchDetail(fixtureId, {
    query: { enabled: !!fixtureId, queryKey: getGetMatchDetailQueryKey(fixtureId) },
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const match = data?.match;
  const stats = match?.stats;
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="detail-modal" role="dialog" aria-modal="true" aria-label="Detalle del partido" data-testid="dialog-match-detail">
      <div className="detail-header"><div><div className="eyebrow">{match ? leagues[match.league] ?? match.league : 'Detalle del fixture'}</div><div className="section-title">{match ? `${match.homeTeam} — ${match.awayTeam}` : 'Cargando partido'}</div><div className="subline">{match ? `${formatDate(match.kickoff)} · ${match.country}` : ''}</div></div><button className="icon-button" onClick={onClose} aria-label="Cerrar detalle"><X size={18} /></button></div>
      <div className="detail-body">
        {isLoading && <SkeletonBlock height={220} />}
        {isError && <ErrorNotice message="No se pudo cargar el detalle del encuentro." retry={() => { void refetch(); }} />}
        {match && <>
          <div className="section-kicker">Estadísticas automáticas · {formatDate(match.lastUpdatedAt)}</div>
          <div className="stats-grid">
            {[
              ['Córners', stats?.homeCorners, stats?.awayCorners],
              ['Tarjetas amarillas', stats?.homeYellowCards, stats?.awayYellowCards],
              ['Tarjetas rojas', stats?.homeRedCards, stats?.awayRedCards],
              ['Tiros a puerta', stats?.homeShotsOnTarget, stats?.awayShotsOnTarget],
            ].map(([label, home, away]) => <div className="stat-cell" key={String(label)}>
              <div className="stat-name">{label}</div><div className="stat-value">{home ?? '—'} <span style={{ color: 'hsl(var(--muted-foreground))' }}>:</span> {away ?? '—'}</div>
            </div>)}
          </div>
          <div className="section-head" style={{ padding: '0 0 10px', border: 0 }}><div><div className="section-kicker">Cuotas recibidas</div><div className="section-title">Mercados · {data.odds.length}</div></div></div>
          {data.odds.length ? <div className="table-wrap"><table className="bet-table"><thead><tr><th>Mercado / selección</th><th>Casa</th><th>Cuota</th><th>Fuente / captura</th></tr></thead><tbody>{data.odds.map(odd => <tr key={odd.id} data-testid={`row-odds-${odd.id}`}>
            <td>{odd.marketName}<div className="subline">{odd.selection}{odd.line == null ? '' : ` · ${odd.line}`}</div>{odd.playerName && <div className="subline">Jugador · {odd.playerName}</div>}</td><td>{odd.bookmaker}</td><td className="mono">{formatValue(odd.decimalOdds, 2)}</td><td>{providerNames[odd.source] ?? odd.source}<div className="subline">{formatDate(odd.capturedAt, { hour: '2-digit', minute: '2-digit' })}</div></td>
          </tr>)}</tbody></table></div> : <EmptyState title="Sin cuotas recibidas" copy="La respuesta del servidor no incluye cuotas para este encuentro." />}
        </>}
      </div>
    </section>
  </div>;
}

function SourcesPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useGetSourceStatus();
  const sync = useRequestDataSync();
  const [scope, setScope] = useState('all');
  const [provider, setProvider] = useState('all');
  const [message, setMessage] = useState('');
  const providerList: Provider[] = provider === 'all' ? ['api-football', 'oddspapi'] : [provider as Provider];
  const submitSync = () => {
    sync.mutate({ data: { scope: scope as 'all' | 'fixtures' | 'odds' | 'stats', providers: providerList } }, {
      onSuccess: result => {
        setMessage(result.message || (result.accepted ? 'La sincronización fue aceptada.' : 'La solicitud no fue aceptada.'));
        void queryClient.invalidateQueries({ queryKey: getGetSourceStatusQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetMatchesQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetValueBetsQueryKey() });
      },
      onError: () => setMessage('No se pudo solicitar la sincronización. Revisa el estado de proveedores e inténtalo de nuevo.'),
    });
  };
  return <>
    <PageHeading eyebrow="Conectividad · límites · sincronización" title="Fuentes de datos" note="Estado comunicado por cada proveedor. Las cuotas y estadísticas dependen de su cobertura." action={<button className="button" onClick={() => void refetch()} data-testid="button-refresh-sources"><RefreshCw size={13} /> Actualizar estado</button>} />
    {isError && <ErrorNotice message="El estado de las fuentes no está disponible desde la API." retry={() => { void refetch(); }} />}
    <div className="sync-toolbar">
      <div><div className="section-kicker">Acción inmediata</div><div style={{ fontSize: 12, marginTop: 5, color: 'hsl(var(--muted-foreground))' }}>Solicitud sujeta a cuota y disponibilidad del proveedor.</div></div>
      <form className="sync-form" onSubmit={event => { event.preventDefault(); submitSync(); }}>
        <select className="select" value={scope} onChange={event => setScope(event.target.value)} aria-label="Ámbito de sincronización" data-testid="select-sync-scope">
          <option value="all">Todo el conjunto</option><option value="fixtures">Fixtures</option><option value="odds">Cuotas</option><option value="stats">Estadísticas</option>
        </select>
        <select className="select" value={provider} onChange={event => setProvider(event.target.value)} aria-label="Proveedor para sincronizar" data-testid="select-sync-provider">
          <option value="all">Ambos proveedores</option><option value="api-football">API-Football</option><option value="oddspapi">OddsPapi</option>
        </select>
        <button className="button primary" type="submit" disabled={sync.isPending} data-testid="button-request-sync"><RefreshCw size={13} className={sync.isPending ? 'animate-spin' : ''} />{sync.isPending ? 'Solicitando…' : 'Solicitar sync'}</button>
      </form>
    </div>
    {message && <div className={`notice ${sync.isError ? 'error' : ''}`} role="status" data-testid="status-sync-result"><Check size={15} />{message}<button className="icon-button" onClick={() => setMessage('')} aria-label="Cerrar aviso" style={{ marginLeft: 'auto' }}><X size={14} /></button></div>}
    {sync.isPending && <div className="notice"><RefreshCw size={14} />Solicitud en curso. Esperando respuesta del servidor…</div>}
    {isLoading ? <div className="source-grid">{[0, 1].map(i => <SkeletonBlock key={i} height={250} />)}</div> : data?.sources?.length ?
      <div className="source-grid">{data.sources.map(source => <SourceCard key={source.provider} source={source} />)}</div> :
      !isError && <div className="panel"><EmptyState title="Sin fuentes configuradas" copy="La API no ha informado de proveedores disponibles." /></div>}
    {data && <div className="panel schedule-strip">
      <div className="schedule-main"><div className="schedule-icon"><CalendarClock size={16} /></div><div><div className="schedule-title">Próxima sincronización programada</div><div className="schedule-sub">{data.scheduleDescription || 'El servidor no ha proporcionado detalles de frecuencia.'}</div></div></div>
      <div className="mono" style={{ fontSize: 12 }}>{formatDate(data.nextScheduledSyncAt, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
    </div>}
    <div className="footer-note">Cuotas, marcas de tiempo y recuentos se muestran únicamente cuando los devuelve el servidor. La ausencia de dato no equivale a cero.</div>
  </>;
}
function SourceCard({ source }: { source: SourceHealth }) {
  const quota = source.requestsRemaining == null || source.requestLimit == null
    ? 'No informado'
    : `${source.requestsRemaining.toLocaleString('es-ES')} / ${source.requestLimit.toLocaleString('es-ES')} restantes`;
  const percent = source.requestsRemaining != null && source.requestLimit != null && source.requestLimit > 0
    ? Math.max(0, Math.min(100, source.requestsRemaining / source.requestLimit * 100))
    : null;
  return <article className="panel source-card" data-testid={`card-source-${source.provider}`}>
    <div className="source-card-top"><div className="source-provider"><div className="source-logo">{source.provider === 'oddspapi' ? 'OP' : 'AF'}</div><div><h2>{providerNames[source.provider] ?? source.provider}</h2><div className="provider-sub">Proveedor de {source.provider === 'oddspapi' ? 'cuotas' : 'fixtures y estadísticas'}</div></div></div><DataState state={source.state} /></div>
    <p className="source-message">{source.message || 'El proveedor no ha comunicado un mensaje de estado.'}</p>
    <div className="quota-box"><div><div className="quota-label">Solicitudes disponibles</div><div className="quota-value">{quota}</div></div><Gauge size={17} color="hsl(var(--primary))" /></div>
    {percent != null && <div style={{ height: 3, background: 'hsl(var(--secondary))', marginTop: 5, borderRadius: 4, overflow: 'hidden' }}><div style={{ height: '100%', width: `${percent}%`, background: 'hsl(var(--primary))', transition: 'transform .2s' }} /></div>}
    <div className="source-meta">
      <div><div className="source-meta-label">Último intento</div><div className="source-meta-value">{formatDate(source.lastAttemptAt)}</div></div>
      <div><div className="source-meta-label">Último éxito</div><div className="source-meta-value">{formatDate(source.lastSuccessAt)}</div></div>
      <div><div className="source-meta-label">Registros recogidos</div><div className="source-meta-value">{source.recordsCollected.toLocaleString('es-ES')}</div></div>
      <div><div className="source-meta-label">Estado</div><div className="source-meta-value">{statusNames[source.state] ?? source.state}</div></div>
    </div>
  </article>;
}

function Router() {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>
    <AppShell>
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route path="/matches" component={MatchPage} />
        <Route path="/sources" component={SourcesPage} />
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  </ErrorBoundary>;
}
function App() {
  return <QueryClientProvider client={queryClient}>
    <TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider>
  </QueryClientProvider>;
}

export default App;