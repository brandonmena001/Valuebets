# Historial mínimo de precios (precio anterior y duración)

## Qué guarda `odds_quotes` (VERIFICADO en código y Postgres embebido con datos simulados)
- Cada par (cuota, `source_updated_at`) distinto es una **fila nueva** (la huella los incluye): el historial de precios observados se conserva.
- Si vuelve la misma cuota y hora, solo se actualiza `captured_at` = **última vez vista**. No hay "primera vez vista".
- `source_updated_at` = `changedAt` (hora del cambio según OddsPapi). Hora de la casa: `bookmaker_changed_at` (columna nueva, llena desde la próxima sincronización).

## Consulta: precio anterior y cuánto duró cada precio
```sql
select decimal_odds as cuota,
       lag(decimal_odds) over w as cuota_anterior,
       source_updated_at as desde,
       lead(source_updated_at) over w as hasta,
       lead(source_updated_at) over w - source_updated_at as duracion,
       captured_at as visto_por_ultima_vez
from odds_quotes
where match_id = :match and bookmaker = :casa and upstream_market_id = :mercado
  and selection = :seleccion
  and line is not distinct from :linea and player_name is not distinct from :jugador
window w as (order by source_updated_at, id)
order by source_updated_at, id;
```
Probada con datos simulados: devolvió p. ej. cuota 3,0 → 3,6 con duración `1 day 06:00:00` y `00:10:00`; la última fila queda con `hasta` nulo (precio vigente, usa `visto_por_ultima_vez`).

## Límites
- Solo se ven precios que existían en una captura. Si un precio cambió dos veces entre capturas, la intermedia no existe en la base.
- La duración está medida con la hora de OddsPapi (`changedAt`), no con la de la casa, salvo que `bookmaker_changed_at` venga llena.
- Si misma clave y misma hora llegan con otra cuota, el colector **actualiza la fila en vez de crear otra** (arreglo del choque de índice), y esa transición no queda en el historial.
- Para un historial completo, OddsPapi ofrece `historical-odds` (ver `presupuesto-llamadas.md`; coste en cuota NO verificado).
