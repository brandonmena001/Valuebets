# Presupuesto de llamadas OddsPapi (límite local: 200/mes)

## Gasto actual (VERIFICADO)
- `requests_used = 121` el 11-oct. Cada captura cuesta **2 llamadas** (BetPlay y Betano) más ~17 al mes de catálogos y torneos (estimado, caché de 7 días).
- Con intervalo fijo de 8 h: ~197 llamadas/mes. Por eso el ritmo ya se estira solo según la cuota restante (ver `docs/handoff-datos.md`).

## Calendario propuesto: capturar antes del inicio
Regla (`lib/odds-budget.ts`, probada con tests): por cada partido aún sin cubrir se captura **3 h antes**; esa captura sirve a los partidos que empiezan **1–5 h después**. Así las cuotas son recientes cuando las casas ya ajustaron y no se gasta nada en horas sin partidos.
- Ejemplo SIMULADO (no es tu calendario): un sábado con 7 partidos en 3 horarios = 3 capturas = 6 llamadas.
- Si el gasto superara la cuota, se descartan las capturas que cubren menos partidos.
- **Resultado con tu calendario real: pendiente.** Corre el reporte (sección 6) y pega la salida; da capturas y llamadas para 2 y 3 casas en los próximos 14 días y en los últimos 30.
- **No está conectado al colector** (solo planificador y simulador). Hoy manda el control existente (separación mínima + ritmo según cuota). Conectarlo es una decisión tuya tras ver la simulación.

## Límite honesto de lo que se puede detectar
- Un error de cuota real dura minutos. Con una captura cada T horas, la probabilidad de verlo es aproximadamente (duración del error)/T: para 10 minutos y T = 3 h, ~5 %. **Con 200 llamadas al mes no se pueden cazar errores de minutos de forma fiable.**
- Lo que sí es viable: cuotas altas convenientes (value) y cuotas que quedaron desactualizadas respecto a otras casas **en el momento de la captura**, y errores que duren horas.
- Cada captura trae `changedAt` por cuota (hora del cambio según OddsPapi). Un precio que cambió hace poco se ve aunque la captura sea tardía, así que el cambio reciente de una casa frente a otra sí es observable.
- Ojo: el endpoint `historical-odds` de OddsPapi (según su documentación: cada cambio de precio con marca de tiempo, datos desde enero 2026, espera de 5 s entre llamadas) permitiría reconstruir **después del partido** qué pasó. **NO verificado** si cuenta contra los 200 y si está en tu plan. Sirve para probar el detector con el pasado, no para detectar en vivo.

---
## Simulación con tu calendario (reporte del 11-oct, versión anterior del cálculo)
- Próximos 14 días: 31 partidos -> 11 capturas -> **39 llamadas con 2 casas, 50 con 3** (20 % y 25 % del tope). Intervalo fijo de 8 h: 101 llamadas en 14 días.
- Últimos 30 días: 24 partidos -> 9 capturas -> 35 llamadas con 2 casas.
- **Esas cifras están subestimadas**: la base solo conoce partidos que OddsPapi ya devolvió y el colector no guarda eventos de más de 48 h. Mi estimación (NO medida): el calendario completo de las 3 ligas es del orden de 2 veces mayor, así que el gasto real con 2 casas rondaría 70–110 llamadas al mes y con 3 casas 100–160. Sigue dentro de 200, pero con menos holgura.
- El reporte ya calcula los últimos 30 días con el **historial importado (calendario completo)** y los próximos 14 con `fixtures.csv` + base. Vuelve a correrlo para tener la cifra sin sesgo.
- Conclusión provisional: un calendario "3 h antes del inicio" cabe con 2 casas, y probablemente con una tercera (Pinnacle) si la sonda confirma que devuelve datos. Sigue sin estar conectado al colector.
