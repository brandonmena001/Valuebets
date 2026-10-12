# Handoff — Fase 2, motor de detección (rama `chat-modelo-2`, base `origin/integracion`)

## Qué cambió
- `lib/db/src/schema/price-anomalies.ts` + export en `schema/index.ts`: tabla NUEVA `price_anomalies` (aditiva), exactamente como el contrato. Contrato para el Chat 3 en `docs/contrato-alertas.md` (publicado en el primer commit).
- `model/anomalies.ts` (puro, sin BD): `looConsensus`, `detectHighPrice`, `detectArbitrage`, `detectInconsistentLines`, `detectSwapped`, `detectInvalid`, `detectStale`, `scoreAnomaly`, `verdictOf` (+ `voidRiskOf`, `suggestedStake`, `modelProbabilityFor`, `analyzeMatch`). Reutiliza `latestEntries`, `consensusSamplesOf`, `consensusOf`, `classifyQuote`, `devigPower`; el leave-one-out es `consensusSamplesOf` sobre las demás casas.
- `model/config.ts`: `anomalyConfig` con todos los umbrales y pesos (variables `ANOMALY_*`; valores iniciales = los del plan).
- `services/anomalies.ts`: `refreshPriceAnomalies({ history?, now? })`: lee cuotas de partidos próximos, detecta, upsert por `log_key` (`detected_at` fijo, `last_seen_at` actualizado), `persisted_syncs += 1` solo si hubo una sincronización nueva de cuotas desde la última vez (`captured_at` posterior a `last_seen_at`), `expired_at` cuando deja de aparecer (si reaparece: se reactiva con `persisted_syncs = 0`). Log "Price anomalies refreshed" con alertas por tipo y veredicto.
- `services/value-model.ts`: llama a `refreshPriceAnomalies` al final de `refreshModelPredictions`, dentro de `try/catch` (un fallo, p. ej. tabla sin crear, solo avisa en logs).
- `scripts/src/anomaly-report.ts`: supervivencia por tipo, distribución de desviaciones, CLV y ROI por tipo y veredicto (`--sim` o `--input=alertas.json`; el SQL de exportación está en la cabecera del archivo).
- `model/predict.ts`: **solo 4 palabras `export`** (`Entry`, `latestEntries`, `consensusSamplesOf`, `consensusOf`), sin cambio de comportamiento. Es una desviación de la regla de archivos propios: sin ellas habría que duplicar la lógica, que pediste evitar. Si prefieres otra vía, dímelo.

## Cómo se probó (resultado real)
- `pnpm install --frozen-lockfile`; `typecheck:libs`, api-server, value-bets, scripts y `pnpm run typecheck` raíz: 0 errores.
- Todos los tests del api-server (`model`, `diagnostics`, `anomalies`, `football-data-parse`, `team-coverage`, `odds-plan`, `error-detail`): **84 pasan, 0 fallan** (23 nuevos en `anomalies.test.ts`).
- Pruebas pedidas, con datos SIMULADOS: (a) ×1.4 en una casa → high-price, desviación ~33 %, riesgo alto; (b) surebet inyectada detectada (margen 2–3 %); (c) línea incoherente y BTTS imposible detectados; (d) 200 partidos × 6 casas, ruido ±3 %, márgenes 4–7 %, 1X2 + 3 líneas de goles: **0 falsas alertas en 10 800 cuotas** (0,000 %); (e) cuota de 10 h → `descartar` y sin apuesta, 5 h → `vigilar`, `stale-line` → `descartar`; (f) con 3 casas no hay high-price, con 4 sí, y con una casa de referencia aguda bastan 2.
- Servicio con Postgres embebido (simulado): inserción, sin doble conteo si se re-ejecuta sin sync nueva, `persisted_syncs` 0→1 con sync nueva, `detected_at` estable, expiración al corregirse la cuota, reactivación y cascade al borrar el partido.
- `anomaly-report.ts --sim` corre; sus cifras (p. ej. ROI) son artefactos de la simulación, no evidencia.

## Qué se midió y qué NO
- Medido: que el código detecta lo inyectado, que no alerta con ruido normal simulado y que la persistencia en BD funciona.
- **NO medido (sin datos reales):** tasa real de falsas alertas (solo ruido uniforme ±3 %, 1X2 y totales; no ±5 %, ni hándicap, córners, props), cuántas alertas sobreviven de verdad, CLV, ROI, probabilidad real de anulación (2/15/50 % son supuestos), ni tiempos de ejecución. **Nada de esto prueba rentabilidad.** No cambié ningún umbral por evidencia (P2 pendiente hasta tener alertas liquidadas).

## Supuestos y riesgos
- `data_age_minutes` = ahora − `captured_at`. El colector refresca `captured_at` aunque la cuota no cambie, así que mide cuándo se confirmó, no cuándo cambió el precio. `stale-line` usa `source_updated_at` solo si el proveedor lo trae (no verificado).
- `ANOMALY_MIN_BOOKS=4` cuenta las casas del mercado incluida la evaluada (consenso con ≥3 otras); con referencia aguda, 2. El nombre de la casa de referencia (`pinnacle` por defecto, coincidencia por texto) NO está verificado contra los nombres reales de `odds_quotes.bookmaker`.
- `arbitrage` en el contrato: `bookmaker = "varias casas"`, `selection_key = "all"`, `decimal_odds` = cuota combinada, una frase por pata en `reasons`; apuesta sugerida = el tope (2 % o 0,5 %) repartido entre las patas (el Kelly no está acotado sin probabilidad).
- Con el plan al pie de la letra, un high-price de ~18 % fresco, sin modelo (acuerdo 0,5) puede salir `tomar` (puntaje ~72, apuesta ≤ 2 %). Si quieres exigir `model_agrees` distinto de `false` o no nulo para `tomar`, es un cambio de una línea en `verdictOf`.
- `persisted_syncs` depende de que el colector actualice `captured_at` en cada sincronización (según el handoff de datos); no verificado con datos reales. El formato de línea del hándicap del proveedor sigue sin verificar (ver Fase 1).
- Sin cambios de dependencias ni de `pnpm-lock.yaml`.

## Comandos en Replit
```
git fetch origin chat-modelo-2 && git checkout chat-modelo-2 && git pull origin chat-modelo-2
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run push     # crea la tabla NUEVA price_anomalies (aditiva)
# reiniciar el API; las alertas se generan al terminar cada refresco del modelo
# reporte (con datos reales, tras exportar alertas.json con el SQL de anomaly-report.ts):
pnpm --filter @workspace/scripts exec tsx src/anomaly-report.ts --input=alertas.json
pnpm --filter @workspace/scripts exec tsx src/anomaly-report.ts --sim   # solo para ver el formato
```
Variables opcionales: `ANOMALY_REFERENCE_BOOKS`, `ANOMALY_MIN_BOOKS`, `ANOMALY_HIGH_DEVIATION`, etc. (lista completa en `model/config.ts`).
