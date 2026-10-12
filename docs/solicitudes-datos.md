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

## 5. Para el detector de errores de cuota (zona del modelo/rutas)
- Para stale-line, usar `coalesce(bookmaker_changed_at, source_updated_at)`. Antes del `db push` y de la primera sincronización nueva, `bookmaker_changed_at` es nulo en todo el historial; `source_updated_at` es la hora de **OddsPapi**, no la de la casa (ver `casas-cobertura.md`).
- No hay casa aguda en los datos actuales (solo BetPlay y Betano).

## 6. Si se activa Pinnacle como tercera casa (decisión del usuario; NO implementado)
Hay que coordinar antes con modelo/rutas/interfaz (zonas ajenas), porque hoy todas las casas de `odds_quotes` se tratan igual:
- Pinnacle es **referencia, no una casa donde apostar**: `value-model.ts` y `routes/**` no deben ofrecerla como "mejor cuota" ni recomendar apostar en ella. Hace falta un criterio explícito (p. ej. lista de casas de referencia o columna) y que el detector la use solo para calcular la cuota justa.
- En el colector (mi zona) el cambio sería: añadir `pinnacle` a las casas seleccionadas y subir `ODDS_CALLS_PER_SYNC` de 2 a 3 en `lib/odds-plan.ts`. Costo: +1 llamada por captura (≈100–160 llamadas/mes con calendario por partidos; estimación mía, NO medida).
- Quedan ~70 llamadas este mes (cuota 129/200 el 11-oct): conviene activarla al iniciar el nuevo periodo o solo en las capturas previas a partidos.
