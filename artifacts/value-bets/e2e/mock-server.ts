/**
 * Servidor de pruebas visuales: sirve dist/public y responde /api/* con datos de EJEMPLO
 * (no reales). Cada respuesta se valida con los esquemas zod de lib/api-zod, así que si el
 * contrato cambia y el dato de ejemplo deja de cumplirlo, el servidor lo dice en voz alta.
 *
 * Uso (desde la raíz del repo, tras `PORT=4173 BASE_PATH=/ pnpm --filter @workspace/value-bets run build`):
 *   pnpm --filter @workspace/scripts exec tsx ../artifacts/value-bets/e2e/mock-server.ts
 *
 * Escenarios (cambian con GET /__scenario?name=...): default | empty | error | loading
 * Variantes de datos: GET /__set?fd=1 (football-data informada) · GET /__set?perf=empty|small|large
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GetDashboardSummaryResponse,
  GetMatchDetailResponse,
  GetMatchesResponse,
  GetModelPerformanceResponse,
  GetSourceStatusResponse,
  GetValueBetsResponse,
  RequestDataSyncResponse,
} from '../../../lib/api-zod/src/index.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '../dist/public');
const port = Number(process.env.MOCK_PORT ?? 4173);

const state = { scenario: 'default', fd: false, perf: 'small' as 'empty' | 'small' | 'large' };

const now = Date.now();
const iso = (offsetMinutes: number) => new Date(now + offsetMinutes * 60_000).toISOString();

const quote = (id: string, category: string, marketName: string, selection: string, odds: number, bookmaker = 'Bet365', line: number | null = null) => ({
  id, category, marketName, selection, playerName: null, line, bookmaker, decimalOdds: odds,
  source: 'oddspapi', sourceUpdatedAt: iso(-20), capturedAt: iso(-12),
});

const valueBet = (id: string, fixtureId: string, home: string, away: string, league: string, extra: Record<string, unknown>) => ({
  ...quote(id, 'goals', 'Goles totales', 'Más de 2.5', 2.1, 'Bet365', 2.5),
  fixtureId, league, homeTeam: home, awayTeam: away, kickoff: iso(60 * 20),
  modelProbability: 0.52, fairOdds: 1.92, expectedValuePct: 9.2, modelVersion: 'dc-nb-market-blend-v2',
  sampleSize: 18, confidence: 'medium', marketProbability: 0.47, kellyFraction: 0.012, bookmakersCount: 6,
  ...extra,
});

const valueBets = [
  valueBet('vb1', 'f1', 'Arsenal', 'Chelsea', 'premier-league', {}),
  valueBet('vb2', 'f2', 'Real Madrid', 'Sevilla', 'la-liga', { ...quote('vb2', 'corners', 'Córners totales', 'Más de 9.5', 1.95, 'Pinnacle', 9.5), modelProbability: 0.58, fairOdds: 1.72, expectedValuePct: 13.1, confidence: 'high', kellyFraction: 0.02 }),
  valueBet('vb3', 'f3', 'Bayern Múnich', 'Borussia Dortmund', 'bundesliga', { ...quote('vb3', 'match-result', '1X2', 'Gana Bayern Múnich', 1.8, 'Betfair'), modelProbability: 0.6, fairOdds: 1.67, expectedValuePct: 8.0, confidence: 'low', kellyFraction: null }),
];

const stats = { homeCorners: null, awayCorners: null, homeYellowCards: null, awayYellowCards: null, homeRedCards: null, awayRedCards: null, homeShotsOnTarget: null, awayShotsOnTarget: null };
const matches = [
  { fixtureId: 'f1', league: 'premier-league', country: 'Inglaterra', homeTeam: 'Arsenal', awayTeam: 'Chelsea', kickoff: iso(60 * 20), status: 'scheduled', homeScore: null, awayScore: null, stats, availableMarkets: ['match-result', 'goals', 'corners'], lastUpdatedAt: iso(-12) },
  { fixtureId: 'f2', league: 'la-liga', country: 'España', homeTeam: 'Real Madrid', awayTeam: 'Sevilla', kickoff: iso(60 * 30), status: 'scheduled', homeScore: null, awayScore: null, stats, availableMarkets: ['match-result', 'goals', 'corners', 'cards'], lastUpdatedAt: iso(-30) },
  { fixtureId: 'f3', league: 'bundesliga', country: 'Alemania', homeTeam: 'Bayern Múnich', awayTeam: 'Borussia Dortmund', kickoff: iso(-35), status: 'live', homeScore: 1, awayScore: 0, stats, availableMarkets: [], lastUpdatedAt: iso(-2) },
  { fixtureId: 'f4', league: 'premier-league', country: 'Inglaterra', homeTeam: 'Liverpool', awayTeam: 'Manchester City', kickoff: iso(-60 * 26), status: 'finished', homeScore: 2, awayScore: 2, stats: { ...stats, homeCorners: 7, awayCorners: 4, homeYellowCards: 2, awayYellowCards: 3, homeRedCards: 0, awayRedCards: 0, homeShotsOnTarget: 6, awayShotsOnTarget: 5 }, availableMarkets: ['goals'], lastUpdatedAt: iso(-60 * 22) },
];

const lines = (values: Array<[number, number]>) => values.map(([line, over]) => ({ line, over }));
const model = {
  modelVersion: 'dc-nb-market-blend-v2',
  expectedGoals: { home: 1.74, away: 1.12 },
  result: { home: 0.49, draw: 0.24, away: 0.27 },
  btts: 0.56,
  topScores: [[1, 1, 0.115], [2, 1, 0.105], [1, 0, 0.098], [2, 0, 0.082], [2, 2, 0.058], [0, 0, 0.049]].map(([home, away, probability]) => ({ home, away, probability })),
  goalLines: lines([[1.5, 0.81], [2.5, 0.55], [3.5, 0.31]]),
  teamStats: [
    { stat: 'corners', homeExpected: 5.9, awayExpected: 4.6, totalExpected: 10.5, lines: lines([[8.5, 0.77], [9.5, 0.64], [10.5, 0.5]]) },
    { stat: 'cards', homeExpected: 1.8, awayExpected: 2.1, totalExpected: 3.9, lines: lines([[2.5, 0.8], [3.5, 0.6], [4.5, 0.37]]) },
    { stat: 'shots-on-target', homeExpected: 5.2, awayExpected: 3.9, totalExpected: 9.1, lines: lines([[7.5, 0.7], [8.5, 0.55]]) },
  ],
  dataQuality: { score: 78, level: 'high', homeSample: 22.4, awaySample: 19.8 },
};

function matchDetail(fixtureId: string) {
  const match = matches.find(item => item.fixtureId === fixtureId);
  if (!match) return null;
  return {
    match,
    odds: valueBets.filter(bet => bet.fixtureId === fixtureId).map(({ id, category, marketName, selection, playerName, line, bookmaker, decimalOdds, source, sourceUpdatedAt, capturedAt }) => ({ id, category, marketName, selection, playerName, line, bookmaker, decimalOdds, source, sourceUpdatedAt, capturedAt })),
    model: match.status === 'scheduled' ? model : null,
  };
}

const source = (provider: string, stateName: string, extra: Record<string, unknown> = {}) => ({
  provider, state: stateName, lastAttemptAt: iso(-15), lastSuccessAt: iso(-15), recordsCollected: 1240,
  requestsRemaining: 62, requestLimit: 100, message: 'Sincronización completada.', ...extra,
});
const sourceStatus = () => ({
  sources: [
    source('api-football', 'partial', { message: 'El plan gratuito no incluye la temporada actual.', requestsRemaining: 41, recordsCollected: 388 }),
    source('oddspapi', 'ok', { requestsRemaining: null, requestLimit: null }),
    ...(state.fd ? [source('football-data', 'ok', { requestsRemaining: null, requestLimit: null, recordsCollected: 5120, message: 'Historial importado.' })] : []),
  ],
  nextScheduledSyncAt: iso(95),
  scheduleDescription: 'Cuotas cada 3 horas; estadísticas una vez al día.',
});

const dashboard = () => ({
  generatedAt: new Date().toISOString(), upcomingMatches: 14, liveMatches: 1, valueBetsCount: valueBets.length,
  averageEvPct: 10.1, latestOddsSync: iso(-15), latestStatsSync: iso(-60 * 5), dataState: 'partial', topValueBets: valueBets,
});

const bucket = (bets: number, wins: number, roi: number | null, se: number | null, clv: number | null, bm: number | null, braw: number | null, bmk: number | null) => ({
  bets, wins, hitRatePct: bets ? (wins / bets) * 100 : null, roiPct: roi, roiStdErrPct: se, avgClvPct: clv,
  avgOdds: bets ? 2.04 : null, brierModel: bm, brierRaw: braw, brierMarket: bmk,
});
function performance() {
  const generatedAt = new Date().toISOString();
  if (state.perf === 'empty') {
    return { generatedAt, pending: 12, overall: bucket(0, 0, null, null, null, null, null, null), byMarket: {}, reliability: 'Muestra insuficiente (0 apuestas liquidadas). Con menos de ~300 apuestas el ROI no es estadísticamente distinguible de la suerte; guíate por el CLV y el Brier mientras tanto.' };
  }
  if (state.perf === 'large') {
    return {
      generatedAt, pending: 31,
      overall: bucket(412, 201, 6.4, 2.9, 1.8, 0.2301, 0.2342, 0.2315),
      byMarket: { goals: bucket(190, 98, 8.1, 4.4, 2.2, 0.2288, 0.2331, 0.2305), corners: bucket(120, 55, 3.2, 5.6, 1.1, 0.2312, 0.2350, 0.2318), 'match-result': bucket(102, 48, 7.0, 6.1, 1.9, 0.2322, 0.2349, 0.2328) },
      reliability: 'Muestra suficiente para una primera lectura; compara el ROI con su error estándar.',
    };
  }
  return {
    generatedAt, pending: 9,
    overall: bucket(42, 19, 3.2, 14.8, -0.6, 0.2472, 0.2569, 0.2441),
    byMarket: { goals: bucket(25, 12, 6.0, 18.5, 0.4, 0.2451, 0.2540, 0.2438), corners: bucket(17, 7, -1.1, 23.9, -1.9, 0.2503, 0.2611, 0.2446) },
    reliability: 'Muestra insuficiente (42 apuestas liquidadas). Con menos de ~300 apuestas el ROI no es estadísticamente distinguible de la suerte; guíate por el CLV y el Brier mientras tanto.',
  };
}

type Handler = () => unknown;
function route(path: string, method: string): Handler | null {
  const empty = state.scenario === 'empty';
  if (method === 'GET' && path === '/api/dashboard') return () => {
    const body = empty ? { ...dashboard(), upcomingMatches: 0, liveMatches: 0, valueBetsCount: 0, averageEvPct: null, topValueBets: [] } : dashboard();
    GetDashboardSummaryResponse.parse(body);
    return body;
  };
  if (method === 'GET' && path === '/api/value-bets') return () => { const body = empty ? [] : valueBets; GetValueBetsResponse.parse(body); return body; };
  if (method === 'GET' && path === '/api/matches') return () => { const body = empty ? [] : matches; GetMatchesResponse.parse(body); return body; };
  const detail = path.match(/^\/api\/matches\/([^/]+)$/);
  if (method === 'GET' && detail) return () => { const body = matchDetail(decodeURIComponent(detail[1]!)); if (!body) return null; GetMatchDetailResponse.parse(body); return body; };
  if (method === 'GET' && path === '/api/sources') return () => { const body = sourceStatus(); GetSourceStatusResponse.parse(body); return body; };
  if (method === 'GET' && path === '/api/model/performance') return () => { const body = performance(); GetModelPerformanceResponse.parse(body); return body; };
  if (method === 'POST' && path === '/api/sync') return () => { const body = { accepted: true, queuedAt: new Date().toISOString(), message: 'Sincronización en cola (datos de ejemplo).' }; RequestDataSyncResponse.parse(body); return body; };
  return null;
}

const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  try {
    if (path === '/__scenario') { state.scenario = url.searchParams.get('name') ?? 'default'; res.end('ok'); return; }
    if (path === '/__set') {
      if (url.searchParams.has('fd')) state.fd = url.searchParams.get('fd') === '1';
      const perf = url.searchParams.get('perf');
      if (perf === 'empty' || perf === 'small' || perf === 'large') state.perf = perf;
      res.end('ok'); return;
    }
    if (path.startsWith('/api/')) {
      if (state.scenario === 'loading') await new Promise(done => setTimeout(done, 6000));
      if (state.scenario === 'error') { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Fallo simulado' })); return; }
      const handler = route(path, req.method ?? 'GET');
      if (!handler) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'No encontrado' })); return; }
      const body = handler();
      if (body === null) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Partido no encontrado.' })); return; }
      res.writeHead(path === '/api/sync' ? 202 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    const info = await stat(file).catch(() => null);
    if (!info || info.isDirectory()) file = join(root, 'index.html');
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch (error) {
    console.error('[mock] error validando o sirviendo', path, error instanceof Error ? error.message : error);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Dato de ejemplo no cumple el contrato' }));
  }
}).listen(port, () => console.log(`[mock] http://localhost:${port} (dist: ${root})`));
