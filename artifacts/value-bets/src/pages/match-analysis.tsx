import { ChevronLeft, AlertCircle, Info } from 'lucide-react';
import { Link, useParams } from 'wouter';
import { getGetMatchDetailQueryKey, useGetMatchDetail, useGetValueBets } from '@workspace/api-client-react';
import type { LineProbability, MatchModel } from '@workspace/api-client-react';
import { AddToSlip } from '@/components/add-to-slip';
import { BetCards } from '@/components/bet-cards';
import { slipItemId } from '@/lib/slip';

const leagues: Record<string, string> = { 'premier-league': 'Premier League', 'la-liga': 'LaLiga', bundesliga: 'Bundesliga' };
const statNames = { corners: 'Córners', cards: 'Tarjetas', 'shots-on-target': 'Tiros a puerta' } as const;
const levelNames = { high: 'Alta', medium: 'Media', low: 'Baja' } as const;

const pct = (value: number, decimals = 1) => `${new Intl.NumberFormat('es-CO', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value * 100)}%`;
const fairOdds = (probability: number) => (probability > 0.001 ? (1 / probability).toFixed(2) : '—');
const when = (value: string) => new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

type Pick = { market: string; selection: string; probability: number };

function PickRow({ fixtureId, match, pick, label }: { fixtureId: string; match: string; pick: Pick; label?: string }) {
  return <div className="fd-pick">
    <div><div className="fd-pick-name">{label ?? pick.selection}</div><div className="fd-bet-sub">Cuota justa {fairOdds(pick.probability)}</div></div>
    <div className="fd-pick-right"><strong>{pct(pick.probability)}</strong>
      <AddToSlip compact item={{ id: slipItemId(fixtureId, pick.market, pick.selection), fixtureId, match, market: pick.market, selection: pick.selection, probability: pick.probability, source: 'model' }} />
    </div>
  </div>;
}

function LineTable({ fixtureId, match, market, lines }: { fixtureId: string; match: string; market: string; lines: LineProbability[] }) {
  return <div className="fd-lines">
    <div className="fd-lines-head"><span>Línea</span><span>Más</span><span>Menos</span></div>
    {lines.map(({ line, over }) => <div className="fd-lines-row" key={line}>
      <span className="mono">{line}</span>
      {([['Más', over], ['Menos', 1 - over]] as const).map(([side, probability]) => <span className="fd-lines-cell" key={side}>
        <em>{pct(probability, 0)}</em>
        <AddToSlip compact item={{ id: slipItemId(fixtureId, `${market} ${line}`, side), fixtureId, match, market: `${market} ${line}`, selection: `${side} de ${line}`, probability, source: 'model' }} />
      </span>)}
    </div>)}
  </div>;
}

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
          <div className="fd-big">{pct(pick.probability)}</div>
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
        <div className="fd-score-line">{score.home}-{score.away}</div><div className="fd-bet-sub">{pct(score.probability, 2)}</div>
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
  const { data, isLoading, isError, refetch } = useGetMatchDetail(fixtureId, { query: { enabled: !!fixtureId, queryKey: getGetMatchDetailQueryKey(fixtureId) } });
  const bets = useGetValueBets();
  const match = data?.match;
  const model = data?.model ?? null;
  const label = match ? `${match.homeTeam} vs ${match.awayTeam}` : '';
  const matchBets = (bets.data ?? []).filter(bet => bet.fixtureId === fixtureId);
  const stats = match?.stats;

  return <div className="fd-page">
    <Link href="/matches" className="fd-back"><ChevronLeft size={15} /> Partidos</Link>
    {isLoading && <div className="skeleton" style={{ height: 240 }} aria-label="Cargando datos" />}
    {isError && <div className="notice error" role="alert"><AlertCircle size={16} /><div style={{ flex: 1 }}>No se pudo cargar el partido.</div><button className="button" onClick={() => void refetch()}>Reintentar</button></div>}
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
              <div className="fd-bar"><div className="fd-bar-fill" style={{ width: `${model.dataQuality.score}%` }} /></div>
              <div className="fd-bet-sub">Partidos efectivos: {model.dataQuality.homeSample.toFixed(0)} local · {model.dataQuality.awaySample.toFixed(0)} visitante</div>
            </div>
          </div>
        </>}
      </section>

      {match.status === 'scheduled' && !model && <div className="notice"><Info size={15} /><span>Aún no hay datos suficientes de ambos equipos para calcular el modelo. Se activará cuando haya más partidos con estadísticas.</span></div>}
      {model && <div className="notice"><Info size={15} /><span>Probabilidades del modelo estadístico, sin mezclar con el mercado. Son una estimación, no una certeza: el mercado suele ser más preciso, así que compara siempre con las value bets de abajo.</span></div>}

      {model && <ModelSections model={model} fixtureId={fixtureId} match={label} home={match.homeTeam} away={match.awayTeam} />}

      <section className="fd-card">
        <h2 className="fd-h">Value bets de este partido</h2>
        {bets.isLoading ? <div className="skeleton" style={{ height: 120 }} /> : <BetCards bets={matchBets} showMatch={false} />}
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
      </details>
    </>}
  </div>;
}
