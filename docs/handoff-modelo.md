# Handoff — rol modelo (rama `chat-modelo`, base `origin/modelo-v3`)

## Qué cambió
- `scripts/src/backtest.ts` (nuevo): backtest walk-forward 1X2. Cada bloque (por defecto 7 días) se predice con un modelo ajustado SOLO con partidos anteriores. Compara log-loss y Brier de (a) modelo puro, (b) mercado sin margen (cierre Avg/B365, método de potencia) y (c) mezcla; hace rejilla de `maxModelWeight`, `ESS_HALF_WEIGHT`, `halfLifeDays`, `priorGames`, separa entrenamiento y prueba posterior en el tiempo, muestra calibración y simula apuestas por umbral de `maxModelMarketGap` (ROI ± error estándar).
- `model/lines.ts` (nuevo): líneas enteras y de cuarto con push, media ganancia y media pérdida; probabilidad efectiva "sin push" y fracción en juego (`risk`).
- `model/markets.ts`: clasifica "ambos anotan", hándicap asiático (2 vías) y totales con línea entera o de cuarto (antes solo .5).
- `model/predict.ts`: BTTS y hándicap en `buildPredictions`; EV real = `risk * (p*cuota - 1)` (con push el EV ingenuo se sobreestima); `fitLeagueModel` acepta `halfLifeDays`/`priorGames` opcionales; consenso de mercado extraído a helpers (sin cambio de comportamiento); `buildMatchSnapshot` acepta `quotes` y devuelve `blended`.
- `model/settle.ts`: liquida BTTS, hándicap y líneas enteras/de cuarto (`push`, `half-win`, `half-loss`).
- `services/prediction-log.ts`: ROI con ganancias parciales; acierto y Brier solo sobre win/loss.
- `model/model.test.ts`: de 20 a 36 pruebas (líneas, clasificación, liquidación, e2e de BTTS/hándicap/totales, ficha mezclada).
- `docs/solicitudes-modelo.md`: cambios que necesito en archivos ajenos (IMPORTANTE: el punto 1 rompe `pnpm run typecheck` raíz hasta aplicarse).

## Cómo se probó (resultado real)
- `pnpm install --frozen-lockfile` OK (sin tocar `pnpm-lock.yaml` ni dependencias).
- `pnpm run typecheck:libs`, typecheck de `api-server` y de `value-bets`: sin errores.
- `tsx --test model.test.ts error-detail.test.ts`: 36 pruebas, 36 OK, 0 fallos.
- Backtest corrido SOLO con CSV simulados (1900 partidos, mercado = verdad + ruido). Sirve para validar que el código funciona, NO como evidencia: allí la mezcla ajustada en entrenamiento empeoró fuera de muestra, lo que ilustra el riesgo de sobreajuste.
- `pnpm run typecheck` raíz: falla en `scripts` (TS6059 por `rootDir`); ver solicitud 1. Con `--rootDir ..` pasa.

## Pendiente / riesgos
- **NO verificado con datos reales**: no hay CSV de football-data en este entorno ni red hacia el proveedor. Por eso NO cambié ningún default (`maxModelWeight`, `ESS_HALF_WEIGHT`, `halfLifeDays`, `priorGames`, `maxModelMarketGap`) ni hice P2 (descanso/forma, solo si el backtest mejora). Hace falta correr el backtest con CSV reales (idealmente 4+ temporadas de varias ligas, con columnas de cierre B365CH/AvgCH/MaxCH).
- El backtest usa cuotas de CIERRE (más precisas que las de producción), así que favorece al mercado; y la simulación de apuestas usa la cuota máxima de cierre como precio.
- BTTS y hándicap reutilizan pesos existentes (`goals` y `match-result`) sin calibrar. El formato de línea del hándicap en el proveedor es un supuesto (ver solicitud 5); si no coincide, el mercado se ignora (no genera apuestas falsas). Faltan muestras reales de `odds_quotes`.
- Sin cambios de base de datos: no hace falta `db push`.
- `blended` no llegará a la API/UI hasta que se apliquen las solicitudes 3a-3c.

## Comandos en Replit
```
git fetch origin chat-modelo && git checkout chat-modelo && git pull origin chat-modelo
pnpm install --frozen-lockfile
# reiniciar el API server (no hay db push)
# backtest (cuando subas los CSV a, p. ej., data/football-data/):
pnpm --filter @workspace/scripts exec tsx src/backtest.ts data/football-data --out=docs/backtest-resultados.md
```
Nombres de archivo: `E0_2324.csv`, `SP1_2324.csv`... o la ruta original `mmz4281/2324/E0.csv`.
