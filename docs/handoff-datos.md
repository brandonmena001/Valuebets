# Handoff: datos y sincronización (rama chat-datos)

## Qué cambió
- `lib/odds-plan.ts` (+test): decide cuándo gastar llamadas de OddsPapi y huella de cuotas por evento.
- `lib/team-coverage.ts` (+test): equipos próximos sin pareja en `historical_results`.
- `lib/error-detail.ts`: `pgErrorInfo`.
- `services/football-data-parse.ts`: `parseFootballDataFixtures` y `parseDate` exportado. `football-data.ts`: `fetchUpcomingFixtures` (en memoria, no escribe en BD).
- `services/football-data-parse.test.ts`: extractos reales E0/SP1/D1 2025/26, E0 2026/27 y fixtures.csv.
- `services/collector.ts`:
  - Cuota OddsPapi: partidos en 24 h → consulta (cada 8 h); solo 24–48 h → máx. 1 vez/24 h; sin partidos → 0 llamadas; solo se piden torneos de ligas con partidos; calendario = fixtures.csv + tabla matches; calendario desconocido → descubrimiento máx. 1/24 h (manual siempre pasa). Eventos de más de 48 h no se guardan.
  - Cuotas sin cambios: un solo UPDATE de `captured_at` (el modelo descarta cuotas de más de 9 h).
  - Log "OddsPapi sync summary" con llamadas por tipo, uso mensual y ligas pedidas/omitidas.
  - Cuotas con choque en `odds_quotes_match_source_market_idx`: se actualiza la fila del mismo jugador; si ocupa otro jugador se cuenta y se avisa.
  - Log de equipos sin emparejar al final de cada ciclo.

## Cómo se probó (resultado real)
- Typecheck libs, api-server y value-bets: exit 0 en los tres.
- Tests (model, error-detail y los 3 archivos nuevos): 38/38 pasan.
- Tests nuevos y Postgres embebido (datos SIMULADOS): persistencia, upsert, refresco de captured_at, choque de índice.

## Pendiente / riesgo
- **P0 sin cerrar**: falta tu salida de `\d odds_quotes`, los índices y el texto "Base de datos: …". NO verificado con tu BD real.
  Reproducido con datos simulados: (a) sin índice `odds_quotes_fingerprint_uq` falla con "no unique or exclusion constraint matching the ON CONFLICT specification (42P10)"; (b) choque de índice por jugador (ver solicitudes-datos.md).
- fixtures.csv: verificado con filas B1 y D1; E0 y SP1 NO verificados. No se escribe en `matches` (riesgo de duplicar con OddsPapi por nombres distintos).
- Contadores de cadencia en memoria: se reinician al reiniciar el servidor (tras un reinicio puede hacer 1 consulta extra).
- No se cambió pnpm-lock.yaml ni dependencias; sin cambios de esquema.

## Comandos en Replit
```
git fetch origin chat-datos && git checkout chat-datos && git pull origin chat-datos
pnpm install --frozen-lockfile
# no hay db push (sin cambios de esquema)
# reiniciar el workflow del API
```
