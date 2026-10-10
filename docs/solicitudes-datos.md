# Solicitudes del rol datos (chat-datos) al supervisor

## 1. Esquema: índice `odds_quotes_match_source_market_idx` sin `player_name` (NO aditivo, requiere decisión)
- Archivo: `lib/db/src/schema/odds.ts`.
- Problema (reproducido con datos SIMULADOS en Postgres embebido; NO verificado con datos reales): dos jugadores con el mismo mercado, selección, línea y `source_updated_at` chocan en ese índice y el segundo se pierde. El colector ahora lo cuenta y lo registra ("Odds quotes dropped…") pero no puede guardarlo.
- Cambio propuesto: reemplazar el índice por uno que incluya `player_name`:
  `drop index odds_quotes_match_source_market_idx; create unique index odds_quotes_match_source_market_idx on odds_quotes (match_id, provider, bookmaker, upstream_market_id, selection, line, player_name, source_updated_at);`
- Motivo: no es aditivo (reemplaza un índice, sin pérdida de datos). No lo apliqué por la regla 4.

## 2. Alias de equipos (`artifacts/api-server/src/model/names.ts`)
Dato REAL del log de Replit (10-oct-2026, 13 partidos próximos): un solo equipo sin emparejar.
- `la-liga`: "RC Deportivo de A Coruna" (nombre de OddsPapi) → "sin coincidencia".
- Cambio propuesto en `PHRASES` (probado en una COPIA de names.ts con "La Coruna" en el historial, que es la forma habitual de football-data; el nombre real en tu `historical_results` aún no está verificado):
  `[/\brc deportivo de a coruna\b/, "deportivo la coruna"],`
- Comprobar antes en Replit el nombre guardado:
  `select distinct home_team from historical_results where league_code='la-liga' and (home_team ilike '%coru%' or home_team ilike '%depor%')`
  Si no devuelve filas, el equipo aún no tiene partidos importados y no es un problema de alias.

## 3. Comando de pruebas
Añadir al comando de tests estándar estos archivos nuevos (están en `artifacts/api-server/src`):
`services/football-data-parse.test.ts lib/odds-plan.test.ts lib/team-coverage.test.ts` (y `pnpm --filter @workspace/db run push` por la tabla nueva `provider_cache`).

## 4. Observación fuera de mi zona (modelo)
En el log real: `Model predictions refreshed` con `predictions: 0`, `history: 1221`, `upcoming: 41`. No investigado (zona del modelo). Conviene revisar por qué no se genera ninguna predicción (¿antigüedad de cuotas > 9 h?, ¿mínimo de partidos por equipo?, ¿marcador de mercados?).
