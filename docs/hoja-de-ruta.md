# Hoja de ruta v2

**Principio:** antes de construir más (alertas, más ligas, más pantallas) hay que responder con datos reales si el modelo aporta algo frente al mercado.

| Etapa | Qué |
|---|---|
| 0 | Desplegar `integracion` en Replit y leer el log `Model funnel` |
| 1 | `pnpm --filter @workspace/scripts run gate` → `docs/resultado-backtest.md` (veredicto) |
| 2 | **Compuerta:** decidir con el veredicto |
| 3A | Si hay ventaja o utilidad como filtro: más ligas, cuotas históricas en BD, calibración, Elo/xG |
| 3B | Si no: «modo referencia» (precio de cada casa frente al precio justo de Pinnacle sin margen) y seguimiento de CLV |

**Congelado hasta la compuerta:** detector de errores de cuota, props de jugador, xG de Understat, lesiones, ligas extra.

**Veredictos posibles** (los calcula `scripts/src/gate-lib.ts`): «ventaja demostrada» (la mezcla supera a Pinnacle de cierre en log-loss con IC95 % por debajo de 0), «utilidad como filtro» (CLV medio positivo con IC95 % por encima de 0, mínimo 200 apuestas) o «sin ventaja demostrada».

## Cómo ejecutar la compuerta (en el Shell de Replit)
```
pnpm --filter @workspace/scripts run gate
```
Descarga con cortesía los CSV de football-data.co.uk (caché de 12 h en `scripts/.cache`, `If-Modified-Since`, 2,5 s entre peticiones, parada ante 429), hace el backtest walk-forward del 1X2 contra la cuota de cierre de Pinnacle sin margen, simula el CLV de apostar a la cuota previa de Bet365 y escribe `docs/resultado-backtest.md`.

Opciones: `--leagues=E0,SP1,D1,I1,F1` (o `all-main`), `--seasons=2627,2526,2425,2324`, `--offline` (solo caché), `--step-days=7`, `--out=ruta.md`. También acepta carpetas con CSV propios: `... run gate -- ./mis-csv`.

Tarda unos minutos (las pausas entre descargas son deliberadas).

**Si la descarga se corta:** el comando reintenta cada archivo (hasta 3 veces, con espera creciente) y solo omite los que fallan; con un 429/403/5xx o tres fallos seguidos detiene el resto. Lo ya descargado queda en `scripts/.cache` (12 h), así que basta volver a correr el comando para continuar. Con menos de 1000 partidos evaluados el veredicto es «datos insuficientes» (no es un resultado).
