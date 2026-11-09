# Decisión: el motor de value bets pasa a «modo referencia»

## Evidencia (backtest real en Replit; informe completo en `docs/resultado-backtest.md`)
5 ligas (E0, SP1, D1, I1, F1), 4 temporadas, 20 CSV de football-data.co.uk. Mercado 1X2, validación walk-forward; referente = cuota de cierre de Pinnacle sin margen (69 % de los partidos; el resto, promedio de cierre).

| Resultado | Cifra |
|---|---|
| Partidos evaluados con el modelo / usados en modo referencia | 3 637 / 5 597 |
| Log-loss: modelo puro · mercado previo · mezcla · cierre de Pinnacle | 0.9919 · 0.9688 · 0.9717 · 0.9667 |
| Mezcla − Pinnacle de cierre | +0.0050, IC95 % [0.0023, 0.0078] → **peor** |
| Mezcla − mercado previo | +0.0030, IC95 % [0.0015, 0.0043] → **el modelo empeora al mercado** |
| Modo referencia (mejor precio vs consenso de las demás casas), umbral 4 % fijado de antemano | 212 apuestas, CLV +0.10 %, IC95 % [−1.27 %, +1.50 %] → **sin señal** |
| Apostar siempre en Bet365 / mejor precio entre casas, CLV frente al cierre | −5.66 % / −1.28 % |

Hallazgos adicionales:
- 179 de las 212 «señales» al 4 % venían de **Betfair Exchange** (CLV −0.06 %), cuyas cuotas no incluyen comisión: no son tomables. Se excluye de las casas que pueden proponer el mejor precio (sigue en el consenso).
- Comparar cuotas sí ahorra margen: el mejor precio entre casas pierde ≈ 4,4 puntos menos que apostar en Bet365. Ese es el valor medido y defendible del producto.

## Decisión
1. `MODEL_MODE=reference` pasa a ser el valor por defecto. El valor sale solo de comparar el precio de cada casa con el consenso (mediana sin margen) de las demás, **sin incluir a la propia casa**.
2. El modelo estadístico deja de intervenir en la probabilidad y en los filtros. Sigue visible en la ficha del partido solo como referencia.
3. No se sugiere stake (`kellyFraction = 0`): no hay ventaja demostrada.
4. La interfaz avisa: «Señales de precio, no ventaja demostrada».
5. Las líneas enteras o de cuarto (hándicap/totales) se omiten en este modo: su riesgo depende de un modelo.
6. El modo anterior sigue disponible con `MODEL_MODE=blend` para experimentar.

Variables: `MODEL_MODE`, `MODEL_REF_MAX_EV_PCT` (tope de cuota atípica, 15), `MODEL_EXCLUDE_PRICE_BOOKS` (casas sin comisión cuyo precio no se propone).

## Qué NO cubre esta decisión
- Solo se evaluó el 1X2. Totales, hándicap, córners, tarjetas y props no están validados.
- Las cuotas previas al cierre de football-data se recogen días antes del partido; la sincronización de la app llega con 7–13 h de antigüedad.
- Las ligas inferiores o menos líquidas pueden comportarse distinto: es el siguiente experimento.

## Cómo reproducirlo
`pnpm --filter @workspace/scripts run gate` (ver `docs/hoja-de-ruta.md`).
