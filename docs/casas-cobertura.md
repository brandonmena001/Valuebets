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
cd artifacts/api-server && pnpm exec tsx src/lib/odds-report.ts
```
Imprime: casas, cobertura por liga y mercado, calidad del reloj, casas agudas en el catálogo guardado y el gasto simulado con tu calendario real.
