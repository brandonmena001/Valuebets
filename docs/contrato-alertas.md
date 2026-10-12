# Contrato de alertas de precio (`price_anomalies`)

Autor: Chat 2 (motor de detección). Lo consumen el Chat 3 (API `GET /api/price-alerts` y pantalla). Solo aditivo: tabla nueva, `pnpm --filter @workspace/db run push` la crea.

## Realidad de los datos
Las cuotas llegan cada 7–13 h y un error real dura minutos: se detectan sobre todo discrepancias persistentes. Cada alerta lleva su antigüedad (`dataAgeMinutes`). Las casas anulan «errores palpables» y pueden limitar cuentas: por eso hay `voidRisk` y la apuesta sugerida se reduce. **Nada de esto promete rentabilidad.**

## Tabla `price_anomalies` (`lib/db/src/schema/price-anomalies.ts`)
| Columna (SQL) | Propiedad Drizzle | Tipo | Notas |
|---|---|---|---|
| id | id | serial PK | |
| match_id | matchId | int, FK matches, cascade | |
| log_key | logKey | text, único | `matchId\|casa\|mercado\|selección\|línea\|jugador\|kind` (campos vacíos = cadena vacía) |
| kind | kind | text | `high-price`, `arbitrage`, `inconsistent-line`, `swapped-selection`, `invalid-odds`, `stale-line` |
| bookmaker | bookmaker | text | casa de la cuota; en `arbitrage` vale `varias casas` |
| market_category, market_name, selection, selection_key | camelCase | text | `selection_key`: home/draw/away/over/under/yes/no; en `arbitrage` vale `all` |
| line | line | double, nulo | |
| player_name | playerName | text, nulo | |
| decimal_odds | decimalOdds | double | en `arbitrage` es la cuota combinada = 1 / suma de implícitas |
| consensus_prob | consensusProb | double, nulo | consenso leave-one-out sin margen |
| fair_odds | fairOdds | double, nulo | 1 / consensus_prob |
| reference_book | referenceBook | text, nulo | casa de referencia aguda usada, si la hubo |
| deviation_pct | deviationPct | double, nulo | `(cuota / cuota_justa − 1) × 100`; en `arbitrage` es el margen × 100 |
| ev_pct | evPct | double, nulo | `(consensus_prob × cuota − 1) × 100`; en `arbitrage` margen × 100 |
| adjusted_ev_pct | adjustedEvPct | double, nulo | `ev_pct × (1 − prob. de anulación)` |
| books_used | booksUsed | int | casas del consenso |
| model_agrees | modelAgrees | boolean, nulo | nulo = sin modelo para ese mercado |
| score | score | int 0–100 | |
| verdict | verdict | text | `tomar`, `vigilar`, `descartar` |
| void_risk | voidRisk | text | `bajo`, `medio`, `alto` |
| suggested_stake_fraction | suggestedStakeFraction | double, nulo | fracción de la banca; nulo si el veredicto no es `tomar` |
| reasons | reasons | text | arreglo JSON de frases en español (en `arbitrage`, una por pata: «Local a 2.50 en casa X») |
| data_age_minutes | dataAgeMinutes | int | edad de la cuota (la más vieja entre las patas en `arbitrage`) |
| detected_at | detectedAt | timestamptz | primera vez que se vio; no cambia |
| last_seen_at | lastSeenAt | timestamptz | última sincronización en que apareció |
| expired_at | expiredAt | timestamptz, nulo | se llena cuando deja de aparecer; si reaparece vuelve a nulo |
| persisted_syncs | persistedSyncs | int, def. 0 | sincronizaciones posteriores a la detección en que sigue apareciendo (0 = recién detectada) |

## Reglas de lectura para la API
- Por defecto, solo `expired_at IS NULL`, ordenadas por `score` descendente.
- `reasons` se parsea con `JSON.parse` y se devuelve como arreglo de textos (si falla, arreglo vacío).
- `GET /api/price-alerts` con filtros `verdict`, `kind`, `minScore`; cada elemento = columnas en camelCase + `homeTeam`, `awayTeam`, `league`, `kickoff` del partido.
- Una alerta de un partido ya empezado no debería mostrarse (el motor solo mira partidos próximos, pero `expired_at` se llena en la siguiente sincronización).

## Veredicto, riesgo y apuesta (resumen; detalle en `model/config.ts`, variables `ANOMALY_*`)
- `void_risk`: bajo si desviación < 15 %; medio 15–25 %; alto > 25 % o si `kind` es `swapped-selection`, `inconsistent-line` o `invalid-odds`. Probabilidad de anulación supuesta: 2 % / 15 % / 50 % (sin calibrar).
- `tomar`: score ≥ 70, riesgo ≠ alto, edad ≤ 180 min, `adjusted_ev_pct` ≥ 3 y `kind` high-price o arbitrage. `descartar`: score < 40, edad > 540 min, o `stale-line` / `invalid-odds`. El resto, `vigilar`.
- `suggested_stake_fraction`: Kelly fraccional del proyecto (25 %) con tope 2 % de la banca (0,5 % si riesgo alto); nulo si no es `tomar`.
