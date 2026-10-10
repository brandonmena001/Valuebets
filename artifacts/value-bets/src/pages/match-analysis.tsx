import { ChevronLeft, Info } from 'lucide-react';
import { Link, useParams } from 'wouter';
import { getGetMatchDetailQueryKey, useGetMatchDetail, useGetValueBets } from '@workspace/api-client-react';
import type { MatchModel } from '@workspace/api-client-react';
import { AddToSlip } from '@/components/add-to-slip';
import { BetCards } from '@/components/bet-cards';
import { LineTable, PickRow, type Pick } from '@/components/market-blocks';
import { EmptyState, ErrorNotice, SkeletonBlock, loadErrorMessage } from '@/components/states';
import { formatDate, formatPct } from '@/lib/format';
import { leagues } from '@/lib/labels';
import { slipItemId } from '@/lib/slip';

const statNames = { corners: 'Córners', cards: 'Tarjetas', 'shots-on-target': 'Tiros a puerta' } as const;
const levelNames = { high: 'Alta', medium: 'Media', low: 'Baja' } as const;

const when = (value: string) => formatDate(value, { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function ModelSections({ model, fixtureId, match, home, away }: { model: MatchModel; fixtureId: string; match: string; home: string; away: string }) {
  const { result } = model;
  const picks: Pick[] = [
    { market: '1X2', selection: `Gana ${home}`, probability: result.home },
    { market: '1X2', selection: 'Empate', probability: result.draw },
    { market: '1X2', selection: `Gana ${away}`, probability: result.away },
  ];
  const double: Pick[] = [
    { market: 'Doble oportunidad', selection: `${home} o empate`, probability: result.home + result.draw },
    { market: 'Doble oportunidad', selection: `${home} o ${away}`, probability: result.home + result.away },
    { market: 'Doble oportunidad', selection: `Empate o ${away}`, probability: result.draw + result.away },
  ];
  return <>
    <section className="fd-card">
      <h2 className="fd-h">Resultado (1X2)</h2>
      <div className="fd-triple">
        {picks.map((pick, index) => <div className={`fd-prob ${index === 0 ? 'home' : index === 2 ? 'away' : ''}`} key={pick.selection}>
          <div className="fd-label">{index === 0 ? 'Local' : index === 2 ? 'Visitante' : 'Empate'}</div>
          <div className="fd-big">{formatPct(pick.probability)}</div>
          <div className="fd-bet-sub">{index === 1 ? 'X' : index === 0 ? home : away}</div>
          <div className="fd-bar"><div className="fd-bar-fill" style={{ width: `${pick.probability * 100}%` }} /></div>
          <AddToSlip compact item={{ id: slipItemId(fixtureId, pick.market, pick.selection), fixtureId, match, market: pick.market, selection: pick.selection, probability: pick.probability, source: 'model' }} />
        </div>)}
      </div>
      <h3 className="fd-sub">Doble oportunidad</h3>
      {double.map(pick => <PickRow key={pick.selection} fixtureId={fixtureId} match={match} pick={pick} />)}
    </section>

    <section className="fd-card">
      <h2 className="fd-h">Marcadores más probables</h2>
      <div className="fd-scores">{model.topScores.map((score, index) => <div className={`fd-score ${index === 0 ? 'top' : ''}`} key={`${score.home}-${score.away}`}>
        <div className="fd-score-line">{score.home}-{score.away}</div><div className="fd-bet-sub">{formatPct(score.probability, 2)}</div>
      </div>)}</div>
    </section>

    <section className="fd-card">
      <h2 className="fd-h">Goles</h2>
      <PickRow fixtureId={fixtureId} match={match} label="Ambos equipos anotan: Sí" pick={{ market: 'Ambos anotan', selection: 'Sí', probability: model.btts }} />
      <PickRow fixtureId={fixtureId} match={match} label="Ambos equipos anotan: No" pick={{ market: 'Ambos anotan', selection: 'No', probability: 1 - model.btts }} />
      <h3 className="fd-sub">Total de goles</h3>
      <LineTable fixtureId={fixtureId} match={match} market="Goles totales" lines={model.goalLines} />
    </section>

    {model.teamStats.map(stat => <section className="fd-card" key={stat.stat}>
      <h2 className="fd-h">{statNames[stat.stat]}</h2>
      <div className="fd-duo">
        <div className="fd-team-box"><div className="fd-team-name">{home}</div><div className="fd-expected">{stat.homeExpected.toFixed(2)}</div><div className="fd-bet-sub">esperados</div></div>
        <div className="fd-team-box"><div className="fd-team-name">{away}</div><div className="fd-expected">{stat.awayExpected.toFixed(2)}</div><div className="fd-bet-sub">esperados</div></div>
      </div>
      <h3 className="fd-sub">Total del partido · {stat.totalExpected.toFixed(1)} esperados</h3>
      <LineTable fixtureId={fixtureId} match={match} market={`${statNames[stat.stat]} totales`} lines={stat.lines} />
    </section>)}
  </>;
}

export default function MatchAnalysisPage() {
  const { fixtureId = '' } = useParams<{ fixtureId: string }>();
  const { data, isLoading, isError, error, refetch } = useGetMatchDetail(fixtureId, { query: { enabled: !!fixtureId, queryKey: getGetMatchDetailQueryKey(fixtureId) } });
  const bets = useGetValueBets();
  const match = data?.match;
  const model = data?.model ?? null;
  const label = match ? `${match.homeTeam} vs ${match.awayTeam}` : '';
  const matchBets = (bets.data ?? []).filter(bet => bet.fixtureId === fixtureId);
  const stats = match?.stats;
  const notFound = isError && (error as { status?: number } | null)?.status === 404;

  return <div className="fd-page">
    <Link href="/matches" className="fd-back"><ChevronLeft size={16} aria-hidden="true" /> Partidos</Link>
    {isLoading && <><SkeletonBlock height={240} /><SkeletonBlock height={160} /></>}
    {notFound && <section className="fd-card"><EmptyState title="Partido no encontrado" copy="Es posible que el partido ya no esté en seguimiento o que el enlace sea incorrecto." action={<Link href="/matches" className="button primary">Ver partidos</Link>} /></section>}
    {isError && !notFound && <ErrorNotice message={loadErrorMessage('el partido')} retry={() => { void refetch(); }} />}
    {match && <>
      <section className="fd-card fd-hero">
        <div className="fd-hero-top"><span className="fd-chip">{leagues[match.league] ?? match.league}</span><span className="fd-bet-sub">{when(match.kickoff)}</span></div>
        <div className="fd-versus">
          <div className="fd-team"><div className="fd-team-name big">{match.homeTeam}</div><div className="fd-label">Local</div></div>
          <div className="fd-vs">{match.status === 'finished' && match.homeScore != null ? `${match.homeScore} - ${match.awayScore}` : 'VS'}</div>
          <div className="fd-team"><div className="fd-team-name big">{match.awayTeam}</div><div className="fd-label">Visitante</div></div>
        </div>
        {model && <>
          <div className="fd-xg">Goles esperados: <strong>{model.expectedGoals.home.toFixed(2)}</strong> — <strong>{model.expectedGoals.away.toFixed(2)}</strong></div>
          <div className="fd-quality">
            <div className="fd-quality-score">{model.dataQuality.score}<span>/100</span></div>
            <div style={{ flex: 1 }}>
              <div className="fd-quality-title">Calidad de datos · {levelNames[model.dataQuality.level]}</div>
              <div className="fd-bar" role="img" aria-label={`Calidad de datos ${model.dataQuality.score} de 100`}><div className="fd-bar-fill" style={{ width: `${model.dataQuality.score}%` }} /></div>
              <div className="fd-bet-sub">Partidos efectivos: {model.dataQuality.homeSample.toFixed(0)} local · {model.dataQuality.awaySample.toFixed(0)} visitante</div>
            </div>
          </div>
        </>}
      </section>

      {match.status === 'scheduled' && !model && <div className="notice" role="status"><Info size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} /><span>Aún no hay datos suficientes de ambos equipos para calcular el modelo. Se activará cuando haya más partidos con estadísticas.</span></div>}
      {model && <div className="notice" role="status"><Info size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} /><span>Probabilidades del modelo estadístico, sin mezclar con el mercado. Son una estimación, no una certeza: el mercado suele ser más preciso, así que compara siempre con las value bets de abajo.</span></div>}

      {model && <ModelSections model={model} fixtureId={fixtureId} match={label} home={match.homeTeam} away={match.awayTeam} />}

      <section className="fd-card">
        <h2 className="fd-h">Value bets de este partido</h2>
        {bets.isLoading ? <SkeletonBlock height={120} />
          : bets.isError ? <ErrorNotice message={loadErrorMessage('las value bets')} retry={() => { void bets.refetch(); }} />
          : <BetCards bets={matchBets} showMatch={false} />}
      </section>

      {match.status !== 'scheduled' && stats && <section className="fd-card">
        <h2 className="fd-h">Estadísticas del partido</h2>
        <div className="stats-grid">{[
          ['Córners', stats.homeCorners, stats.awayCorners], ['Amarillas', stats.homeYellowCards, stats.awayYellowCards],
          ['Rojas', stats.homeRedCards, stats.awayRedCards], ['Tiros a puerta', stats.homeShotsOnTarget, stats.awayShotsOnTarget],
        ].map(([name, h, a]) => <div className="stat-cell" key={String(name)}><div className="stat-name">{name}</div><div className="stat-value">{h ?? '—'} : {a ?? '—'}</div></div>)}</div>
      </section>}

      <details className="fd-card">
        <summary className="fd-h" style={{ cursor: 'pointer' }}>Cuotas recibidas · {data.odds.length}</summary>
        {data.odds.length ? <div className="table-wrap"><table className="bet-table"><thead><tr><th>Mercado</th><th>Casa</th><th>Cuota</th></tr></thead><tbody>{data.odds.slice(0, 200).map(odd => <tr key={odd.id}>
          <td>{odd.marketName}<div className="subline">{odd.selection}{odd.line == null ? '' : ` · ${odd.line}`}{odd.playerName ? ` · ${odd.playerName}` : ''}</div></td>
          <td>{odd.bookmaker}</td><td className="mono">{odd.decimalOdds.toFixed(2)}</td>
        </tr>)}</tbody></table></div> : <div className="fd-bet-sub">Sin cuotas recibidas.</div>}
        {data.odds.length > 200 && <div className="fd-bet-sub" style={{ marginTop: 8 }}>Se muestran las 200 cuotas más recientes de {data.odds.length}.</div>}
      </details>
    </>}
  </div>;
}
