# Resultado del backtest (compuerta)

Generado: 2026-10-23T01:59:42.914Z · Archivos CSV: 20 · Partidos evaluados: **3637** · Ligas: D1, E0, F1, I1, SP1
Referente: cuota de cierre de Pinnacle sin margen en el 69 % de los partidos (el resto, promedio de cierre del mercado).

## Veredicto: **sin ventaja demostrada**

- La mezcla es PEOR que el cierre de Pinnacle: log-loss +0.0050 (IC95 % [0.0023, 0.0078]).
- También es PEOR que el mercado previo (+0.0030, IC95 % [0.0015, 0.0043]): mezclar el modelo EMPEORA la probabilidad que ya teníamos; el modelo no aporta información.
- Solo 57 apuestas simuladas con Bet365 (mínimo 200 para concluir).
- Apostar TODAS las selecciones a la cuota de Bet365 da CLV -5.69 %; el filtro del modelo da -5.02 % en 57 apuestas: efecto del filtro +0.67 puntos (±2.99).
- Apostar TODAS las selecciones a la cuota máxima del mercado da CLV -1.95 %; el filtro del modelo da -1.28 % en 392 apuestas: efecto del filtro +0.68 puntos (±1.00).
- Sin modelo (solo precio frente al consenso) hay apenas 28 apuestas con el máximo del mercado: muestra insuficiente para comparar.

## 1. Calidad de la probabilidad (1X2, menor es mejor)

| Fuente | Log-loss | Brier |
|---|---|---|
| Modelo puro | 0.9919 | 0.5915 |
| Mercado previo al cierre (sin margen) | 0.9688 | 0.5761 |
| Mezcla de producción | 0.9717 | 0.5779 |
| **Cierre de Pinnacle (referente)** | 0.9667 | 0.5747 |

- Mezcla − Pinnacle de cierre (log-loss, IC95 % bootstrap pareado): **0.0050 [0.0023, 0.0078]**. Negativo = la mezcla es mejor.
- Mezcla − mercado previo (IC95 %): **0.0030 [0.0015, 0.0043]**. Negativo = el modelo aporta algo sobre el mercado que ya teníamos.

## 2. Utilidad como filtro: apostar a la cuota previa al cierre

CLV = cuota tomada × probabilidad justa de cierre de Pinnacle − 1. Un CLV medio positivo sostenido es la señal más fiable de ventaja; el ROI de pocas apuestas es ruido.

| Cuota tomada | Selección | Apuestas | CLV medio [IC95 %] | ROI medio [IC95 %] | Acierto |
|---|---|---|---|---|---|
| Bet365 | con modelo (mezcla) | 57 | -5.02 % [-7.98 %, -2.02 %] | 36.42 % [-15.86 %, 92.25 %] | 29.8 % |
| Bet365 | sin modelo (solo precio vs consenso) | 1 | 2.07 % [—, —] | -100.00 % [—, —] | 0.0 % |
| Bet365 | **todas las selecciones (sin filtro)** | 9894 | -5.69 % [-5.83 %, -5.54 %] | -5.38 % [-8.17 %, -2.46 %] | 35.2 % |
| Máximo del mercado | con modelo (mezcla) | 392 | -1.28 % [-2.25 %, -0.28 %] | -2.70 % [-19.42 %, 15.91 %] | 23.7 % |
| Máximo del mercado | sin modelo (solo precio vs consenso) | 28 | 5.19 % [1.53 %, 9.14 %] | -1.71 % [-46.00 %, 44.50 %] | 42.9 % |
| Máximo del mercado | **todas las selecciones (sin filtro)** | 9722 | -1.95 % [-2.10 %, -1.80 %] | -1.99 % [-4.95 %, 0.96 %] | 35.7 % |

Filtros usados: los de producción (EV entre 4 % y 20 %, cuota entre 1.2 y 6, brecha modelo-mercado ≤ 0.08, doble confirmación, precio atípico > 10 % descartado).

## 3. Calibración de la mezcla

| Tramo | Selecciones | Predicho | Observado |
|---|---|---|---|
| 0–10 % | 315 | 7.5 % | 5.1 % |
| 10–20 % | 1579 | 15.9 % | 14.4 % |
| 20–30 % | 4190 | 25.4 % | 25.9 % |
| 30–40 % | 1791 | 34.4 % | 32.7 % |
| 40–50 % | 1208 | 44.7 % | 46.3 % |
| 50–60 % | 879 | 54.7 % | 54.5 % |
| 60–70 % | 559 | 64.6 % | 65.7 % |
| 70–80 % | 294 | 74.5 % | 78.9 % |
| 80–90 % | 93 | 84.0 % | 89.2 % |
| 90–100 % | 3 | 92.1 % | 100.0 % |

## 4. Modo referencia: comparar las casas entre sí (sin modelo)

Para cada partido y resultado se toma el **mejor precio** entre las casas y se compara con el consenso (mediana de probabilidades sin margen) de las **demás** casas; el CLV se mide frente al cierre de Pinnacle. Partidos usados: 5597 de 5602 (mínimo 4 casas con cuotas y referente de cierre).

**Conclusión del modo referencia: sin señal de precio.** Con umbral 4 %: 212 apuestas, CLV medio 0.10 % (IC95 % [-1.27, 1.50]).

| Umbral de valor (EV vs consenso) | Apuestas | Por 1000 partidos | CLV medio [IC95 %] | ROI medio [IC95 %] |
|---|---|---|---|---|
| ≥ 1 % (hasta 15 %) | 2373 | 424.0 | -0.41 % [-0.74 %, -0.08 %] | -1.45 % [-7.06 %, 4.65 %] |
| ≥ 2 % (hasta 15 %) | 1016 | 181.5 | -0.49 % [-1.03 %, 0.05 %] | 1.57 % [-8.12 %, 12.06 %] |
| ≥ 3 % (hasta 15 %) | 447 | 79.9 | -0.48 % [-1.36 %, 0.40 %] | 1.61 % [-13.85 %, 17.18 %] |
| ≥ 4 % (hasta 15 %) | 212 | 37.9 | 0.10 % [-1.27 %, 1.50 %] | 1.16 % [-21.33 %, 25.42 %] |
| ≥ 5 % (hasta 15 %) | 102 | 18.2 | 1.53 % [-0.55 %, 3.59 %] | 20.48 % [-15.40 %, 60.73 %] |
| ≥ 6 % (hasta 15 %) | 41 | 7.3 | 1.88 % [-1.77 %, 5.78 %] | 27.00 % [-34.59 %, 97.37 %] |
| ≥ 8 % (hasta 15 %) | 8 | 1.4 | -3.65 % [-10.59 %, 4.02 %] | 28.75 % [-100.00 %, 212.50 %] |
| **Mejor precio, sin filtro** | 14828 | — | -1.28 % [-1.39 %, -1.16 %] | -1.25 % [-3.56 %, 1.07 %] |

El umbral es descriptivo: el veredicto usa solo el umbral de 4 % fijado de antemano, para no elegir a posteriori el que mejor salga.

| Casa | Partidos | CLV de apostar SIEMPRE en esa casa | Veces mejor precio (umbral 4 %) | CLV de esas apuestas |
|---|---|---|---|---|
| BFE | 3288 | -0.95 % | 179 | -0.06 % |
| 1XB | 1498 | -1.87 % | 19 | 3.95 % |
| PS | 3914 | -3.57 % | 4 | -0.32 % |
| B365 | 5060 | -5.66 % | 3 | -14.49 % |
| BF | 1557 | -5.08 % | 3 | -8.53 % |
| BMGM | 1574 | -5.69 % | 2 | 7.00 % |
| LB | 1208 | -6.75 % | 1 | 6.62 % |
| IW | 786 | -5.27 % | 1 | 5.44 % |
| BW | 4438 | -6.11 % | 0 | — |
| WH | 2786 | -6.98 % | 0 | — |
| BFD | 1908 | -6.07 % | 0 | — |
| BV | 1904 | -7.76 % | 0 | — |
| VC | 1574 | -6.85 % | 0 | — |
| CL | 1178 | -6.04 % | 0 | — |
| SKB | 309 | -7.69 % | 0 | — |
| PP | 308 | -7.65 % | 0 | — |

## Lo que este informe NO demuestra

- Solo cubre el mercado 1X2. Los totales, hándicap, córners y tarjetas no están evaluados.
- Las cuotas «previas al cierre» de football-data se recogen días antes del partido (martes y viernes); sirven para medir CLV, no para simular apuestas en vivo.
- La cuota de Bet365 es la publicada en la fuente, no necesariamente tomable (límites, cierre de cuentas).
- Un resultado positivo con pocas apuestas puede ser suerte: mira el IC95 % y el tamaño de muestra. Un resultado negativo es igual de útil.
