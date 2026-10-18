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
