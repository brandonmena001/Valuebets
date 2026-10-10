# Solicitudes del rol datos (chat-datos) al supervisor

## 1. Esquema: índice `odds_quotes_match_source_market_idx` sin `player_name` (NO aditivo, requiere decisión)
- Archivo: `lib/db/src/schema/odds.ts`.
- Problema (reproducido con datos SIMULADOS en Postgres embebido; NO verificado con datos reales): dos jugadores con el mismo mercado, selección, línea y `source_updated_at` chocan en ese índice y el segundo se pierde. El colector ahora lo cuenta y lo registra ("Odds quotes dropped…") pero no puede guardarlo.
- Cambio propuesto: reemplazar el índice por uno que incluya `player_name`:
  `drop index odds_quotes_match_source_market_idx; create unique index odds_quotes_match_source_market_idx on odds_quotes (match_id, provider, bookmaker, upstream_market_id, selection, line, player_name, source_updated_at);`
- Motivo: no es aditivo (reemplaza un índice, sin pérdida de datos). No lo apliqué por la regla 4.

## 2. Alias de equipos (`artifacts/api-server/src/model/names.ts`)
- Pendiente de datos reales: tras la próxima sincronización busca en los logs de Replit la línea
  `Upcoming teams without a match in historical_results` y pega el campo `unmatched`. Con eso se listan aquí los alias exactos.
- Comprobado localmente con nombres de football-data de las muestras (Ein Frankfurt, Vallecano, Man United, Ath Madrid…) y nombres completos supuestos (no son los reales de OddsPapi): `resolveName` los empareja.

## 3. Comando de pruebas
Añadir al comando de tests estándar estos archivos nuevos (están en `artifacts/api-server/src`):
`services/football-data-parse.test.ts lib/odds-plan.test.ts lib/team-coverage.test.ts` (y `pnpm --filter @workspace/db run push` por la tabla nueva `provider_cache`).
