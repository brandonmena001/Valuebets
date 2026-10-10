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
  - Separación mínima entre sincronizaciones programadas (≥7 h, mayor si la cuota restante lo exige); una omisión conserva el estado anterior en Fuentes.
  - Catálogos de OddsPapi persistidos en `provider_cache` (0 llamadas tras reiniciar).
  - Log "OddsPapi sync summary" con llamadas por tipo, uso mensual y ligas pedidas/omitidas.
  - Cuotas con choque en `odds_quotes_match_source_market_idx`: se actualiza la fila del mismo jugador; si ocupa otro jugador se cuenta y se avisa.
  - Log de equipos sin emparejar al final de cada ciclo.

## Cómo se probó (resultado real)
- Typecheck libs, api-server y value-bets: exit 0 en los tres.
- Tests (model, error-detail y los 3 archivos nuevos): 38/38 pasan.
- Tests nuevos y Postgres embebido (datos SIMULADOS): persistencia, upsert, refresco de captured_at, choque de índice.

## Pendiente / riesgo
- **P0 (estado real)**: tu `\d odds_quotes` muestra el esquema SINCRONIZADO (columnas y los dos índices únicos), así que NO falta ningún índice. Tu fila `source_status` de oddspapi está en `ok` con 8163 registros con la versión ab15b43: la sincronización ya no se cae. Siguen sin verse las filas que se omiten (puede haber choques de índice); falta una línea de log `Some odds quotes could not be saved` para confirmarlo.
- **Cuota real**: `requests_used = 117/200` el 10-oct. Causas probables (no verificadas): reinicios de Replit que repiten la sincronización inicial y las 3 llamadas de catálogos. Ahora: separación mínima 7 h persistida + ritmo ajustado a la cuota restante (≈13 h con 117/200 el día 10) + catálogos en `provider_cache`.
- (Reproducido con datos simulados, antes de ver tu esquema:)
  Reproducido con datos simulados: (a) sin índice `odds_quotes_fingerprint_uq` falla con "no unique or exclusion constraint matching the ON CONFLICT specification (42P10)"; (b) choque de índice por jugador (ver solicitudes-datos.md).
- fixtures.csv: verificado con filas B1 y D1; E0 y SP1 NO verificados. No se escribe en `matches` (riesgo de duplicar con OddsPapi por nombres distintos).
- La separación entre sincronizaciones se lee de `source_status.last_success_at` (sobrevive a reinicios); solo `lastDiscoveryAt` queda en memoria.
- No se cambió pnpm-lock.yaml ni dependencias. Esquema: solo la tabla NUEVA `provider_cache` (aditiva; si no se hace db push, el código cae a la API como antes y avisa en logs).

## Comandos en Replit
```
git fetch origin chat-datos && git checkout chat-datos && git pull origin chat-datos
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run push   # crea la tabla nueva provider_cache (aditiva)
# reiniciar el workflow del API
```
