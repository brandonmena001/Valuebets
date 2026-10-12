# Casas y cobertura (datos reales de tu base, 10-oct-2026)

## Casas capturadas (VERIFICADO con tus consultas)
| Casa | Cuotas | Partidos | Última captura (UTC) |
|---|---|---|---|
| BetPlay | 28 559 | 55 | 2026-10-11 01:43 |
| Betano | 15 369 | 43 | 2026-10-10 16:49 |

- Solo 2 casas, y las dos son casas "blandas". **No hay casa de referencia aguda en lo capturado.**
- El código pide a OddsPapi solo BetPlay y Betano (1 llamada por casa y captura). Una tercera casa = +1 llamada por captura.

## Mercados (VERIFICADO, top 40 por volumen)
Categorías presentes: `goals`, `corners`, `cards`, `shots-on-target` y `match-result` (Full Time Result, ~507 cuotas). La mayoría del volumen son **mercados de jugador y de equipo**: Anytime/First/Last Goal Scorer, Player To Be Carded, Over/Under de tiros del jugador, córners y tarjetas por equipo y por mitad. El 1X2 es una fracción pequeña.
- Pendiente: cobertura por liga (partidos por liga y casa). Sale en la sección 2 del reporte (ver abajo).

## ¿Existe una casa aguda (Pinnacle)?
- **NO verificado con tu clave.** Fuentes de OddsPapi (blog y documentación) dicen que agrega Pinnacle entre ~350 casas; eso es afirmación del proveedor.
- Cómo comprobarlo sin gastar llamadas: tras la primera sincronización posterior al `db push`, el catálogo queda en `provider_cache` y el reporte (sección 5) lista las casas agudas que figuran. **Que figure en el catálogo no prueba que devuelva cuotas de estas ligas**: haría falta una captura de prueba de 1 llamada.

## ¿`source_updated_at` es la hora de cada casa? (P0)
- **No lo es, según la documentación oficial.** Cada cuota trae dos horas: `changedAt` (último cambio **registrado por OddsPapi**) y `bookmakerChangedAt` (último cambio **reportado por la casa**, "si lo da"). El código guardaba `changedAt` y solo usaba la de la casa si faltaba, y esa nunca se guardaba.
- Dato real: la media de `captured_at - source_updated_at` en filas de los últimos 2 días es **48,3 h (BetPlay)** y **27,8 h (Betano)**. Es decir, el último cambio que OddsPapi vio en esas cuotas fue hace 1–2 días. Difieren entre casas, pero **no prueba que sea la hora de cada casa**; puede ser simplemente que BetPlay mueve menos sus precios.
- Corrección hecha (aditiva): columna nueva `odds_quotes.bookmaker_changed_at`, nullable, que guarda `bookmakerChangedAt`. `source_updated_at` y la huella no cambian (no se reescribe el historial).
- **Qué falta para decidir si stale-line es fiable:** correr `db push`, dejar pasar una sincronización real y mirar la sección 4 del reporte: porcentaje de filas con hora de la casa. Si es bajo o cero, **la señal stale-line solo puede apoyarse en `changedAt` (hora de OddsPapi), no en la de cada casa**, y habrá que compararla contra el movimiento de otras casas, no contra la hora.
- Hallazgo no explicado: la sincronización de las 01:43 actualizó BetPlay pero no Betano (última captura de Betano 16:49 del día anterior) y `requests_used` subió de 117 a 121. Se ejecutó con el código anterior. Causa NO investigada.

## Reporte de un comando (solo lectura, no gasta cuota)
```
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/src/lib/odds-report.ts
```
Imprime: casas, cobertura por liga y mercado, calidad del reloj, casas agudas en el catálogo guardado y el gasto simulado con tu calendario real.

---
## Actualización con el reporte real del 11-oct-2026 15:17 UTC (VERIFICADO con tu salida)
- Casas: BetPlay 30 061 cuotas / 55 partidos; Betano 18 059 / 44 partidos.
- Cobertura por liga (partidos con cuotas): Bundesliga 18 y 18; Premier 20 y 20; **La Liga BetPlay 17 vs Betano 6** (Betano casi no cubre La Liga).
- Mercados: goals (15 tipos en ambas), corners (BetPlay 12, Betano 11), cards (BetPlay 7, Betano 11), match-result (1 tipo en ambas), **shots-on-target solo BetPlay (925 cuotas)**.
- Reloj: media de 19,1 (BetPlay) y 17,4 (Betano) horas de cambio distintas por partido; solo 1 partido de BetPlay y ninguno de Betano tienen una única hora. Es coherente con una hora **por cuota** y no con la hora del evento, pero la cifra se acumula entre capturas y no demuestra por sí sola que sea la hora de la casa.
- Hora que reporta la casa: **0 de 30 061 y 0 de 18 059**. Esperado: la columna acaba de crearse y el servidor que sincronizó a las 15:17 aún no usaba el código nuevo. Cuando se reinicie con `chat-datos-2` y sincronice, el reporte (sección 4) mostrará el porcentaje real. Si queda en 0, OddsPapi no entrega `bookmakerChangedAt` para estas casas y stale-line solo puede basarse en `changedAt`.
- Catálogo guardado: **360 casas**. Figuran `pinnacle`, `pinnacle+30`, `pinnacle+5`, `betfair-ex`, `betfair.es`, `betfair.it`, `matchbook`, `sbobet`, `singbet`, `singbet-b`, `singbet-c`. **Que figuren NO prueba que devuelvan cuotas de estas ligas o mercados de jugador con tu clave.**
- Prueba de 1 llamada (sin guardar nada) para confirmarlo: `pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/src/lib/odds-probe.ts pinnacle --ejecutar` (sin `--ejecutar` solo simula). Imprime eventos por liga, cuotas por categoría, cuántas traen hora de la casa y antigüedad de `changedAt`. También sirve con `betplay` para saber si esa casa entrega hora propia.

---
## Sonda real de Pinnacle (1 llamada, 11-oct-2026; VERIFICADO con tu salida)
- **59 eventos** de las 3 ligas (La Liga 22, Premier 21, Bundesliga 16): más partidos que BetPlay (55) y Betano (44).
- 2 737 cuotas: goals 2 442, match-result 177, corners 72, cards 46. **No trae `shots-on-target`** ni, a la vista, mercados de jugador: no sirve de referencia para la mayor parte del volumen de BetPlay (goleador, tarjetas y tiros por jugador).
- **Hora que reporta la casa: 2 665 de 2 737 (97 %)**. Para Pinnacle, OddsPapi sí entrega `bookmakerChangedAt`.
- Antigüedad de `changedAt`: mínima 0,6 h, mediana 4,8 h, máxima 6,8 h. Comparado con la media de ~48 h de BetPlay y ~28 h de Betano, los precios de Pinnacle se mueven con más frecuencia. Causa NO verificada (puede ser actividad real de la casa o cómo OddsPapi refresca esa casa).
- Pendiente: solape exacto de mercados con BetPlay y Betano (la sonda actualizada lo imprime; cuesta 1 llamada más) y si BetPlay y Betano entregan hora propia (sonda con `betplay` y `betano`, 1 llamada cada una, o esperar una sincronización con el código nuevo, gratis).
