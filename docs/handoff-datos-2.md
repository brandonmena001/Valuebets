# Handoff Fase 2: datos (rama chat-datos-2)

**Base**: la rama `integracion` NO existe en el remoto; `chat-datos-2` se creó desde `chat-datos` (provisional). Al integrar, rebasar sobre `integracion` cuando exista.

## Qué cambió
- Esquema (aditivo): `odds_quotes.bookmaker_changed_at` (nullable). Requiere `db push`.
- `oddspapi.ts`: guarda `bookmakerChangedAt`; `extractQuotes` exportado. `collector.ts`: lo persiste (insert, upsert y arreglo de choque).
- `lib/odds-budget.ts` (+test): planificador "capturar antes del inicio" y simulador de gasto. Sin conectar al colector.
- `lib/odds-report.ts`: reporte de solo lectura (casas, cobertura, reloj, casas agudas en catálogo, gasto simulado).
- `lib/odds-probe.ts`: sonda de 1 llamada (simula sin `--ejecutar`; no guarda cuotas; suma 1 al contador; se niega si quedan menos de 12 llamadas). Verificada solo en simulación y con casa inexistente; la llamada real NO se ha probado.
- Reporte: sección 6 ahora usa el historial importado (30 días) y fixtures.csv.
- Tests: `services/oddspapi.test.ts` (evento SIMULADO), `lib/odds-budget.test.ts`.
- Docs: `casas-cobertura.md`, `presupuesto-llamadas.md`, `historial-precios.md`, `proveedores-tiempo-real.md`.

## Cómo se probó
Resultados en la sección Verificación del mensaje final (typecheck, tests, Postgres embebido con datos SIMULADOS).

## Pendiente / riesgo
- Cobertura por liga, hora de la casa y gasto con tu calendario real: dependen de correr el reporte en Replit. NO verificado hasta entonces.
- ¿Es fiable stale-line? Aún no: `source_updated_at` es hora de OddsPapi.
- Pinnacle: NO verificado con tu clave.
- Sin cambios en `pnpm-lock.yaml`.

## Comandos en Replit
```
git fetch origin chat-datos-2 && git checkout chat-datos-2 && git pull origin chat-datos-2
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run push
# reiniciar el API; tras una sincronización real:
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/src/lib/odds-report.ts   # desde la raíz del repo (tsx está en scripts, no en api-server)
```
