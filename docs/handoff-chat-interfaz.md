# Handoff — chat de interfaz y contrato (rama `chat-interfaz`, base `modelo-v3`)

## Qué cambió
- **Contrato** (`lib/api-spec/openapi.yaml`, regenerados `lib/api-client-react` y `lib/api-zod`): nuevo `GET /model/performance` (`ModelPerformance`, `PerformanceBucket`); `Provider` ahora incluye `football-data`; nuevo `SyncProvider` (solo `api-football`/`oddspapi`) para `POST /sync`, así que la sincronización manual no cambia.
- **API:** `routes/model.ts` valida la respuesta con el zod generado.
- **P0 `/rendimiento`** (`pages/performance.tsx`, enlace en el menú): ROI ± error estándar con veredicto (intervalo ≈95 %), CLV, acierto, pendientes, Brier modelo/modelo puro/mercado, desglose por mercado y el aviso de fiabilidad del servidor con barra hacia 300 apuestas.
- **P1 Fuentes:** tarjeta de `football-data` siempre visible; si la API aún no la informa muestra «Sin informe» (no cuenta como error en el estado global).
- **P1 pulido móvil:** estados de carga/vacío/error en todas las pantallas (`components/states.tsx`), 404 de partido, textos en español (404, error boundary, `lang="es"`), menú inferior táctil, objetivos ≥44 px, textos ≥11 px, contraste corregido, `prefers-reduced-motion`, foco visible, zoom permitido.
- **Cupón:** banca persistente, «Registrar apuesta» e historial con resultado (ganó/perdió/nula) que ajusta la banca y se puede corregir. Todo en `localStorage` del navegador (`lib/bankroll.tsx`).
- **P2:** NO hecho: falta `docs/solicitudes-modelo.md`. Dejé `components/market-blocks.tsx` reutilizable. Ver `docs/solicitudes-chat-interfaz.md`.
- Herramienta: `artifacts/value-bets/e2e/` (servidor de ejemplo que valida con zod + capturas a 390 px con auditoría).

## Cómo se probó (resultado real)
- `pnpm install --frozen-lockfile`, `typecheck:libs`, typecheck de api-server y de value-bets: sin errores.
- Tests del modelo y `error-detail`: 20 pasan, 0 fallan.
- Build y 16 capturas a 390 px con Playwright (resumen, partidos, partido, cupón con historial, rendimiento pequeña/grande/vacía, fuentes con y sin football-data, error, vacío, carga, 404): sin desborde horizontal ni errores de consola; auditoría automática sin objetivos <44 px, sin texto <11 px y sin contraste <4,5:1 (aproximado).
- **NO verificado con datos reales:** todo se vio con datos de EJEMPLO (`e2e/mock-server.ts`). Falta ver `/rendimiento` y Fuentes con la API real. La fuente de las fuentes tipográficas (Google Fonts) estaba bloqueada aquí; se usó la tipografía de respaldo.

## Pendiente / riesgos
- football-data no tendrá estado real hasta que el collector lo escriba (solicitud 1).
- La barra «de 300» replica el umbral del texto del servidor; si cambia allí, hay que cambiar `SAMPLE_TARGET` en `performance.tsx`.
- El Brier se calcula solo sobre apuestas recomendadas (sesgo de selección); la pantalla lo avisa.
- Banca e historial viven en el navegador: no se sincronizan entre dispositivos.
- Sin cambios de dependencias, `pnpm-lock.yaml` ni base de datos (no hace falta `db push`).

## Comandos en Replit
```
git fetch origin && git checkout chat-interfaz && git pull origin chat-interfaz
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-spec run codegen   # opcional: ya está regenerado
```
Reinicia el API y el frontend (workflows de Replit). Prueba `/rendimiento` y `/sources`.

## Repetir las capturas
```
PORT=4173 BASE_PATH=/ pnpm --filter @workspace/value-bets run build
pnpm --filter @workspace/scripts exec tsx ../artifacts/value-bets/e2e/mock-server.ts &
python3 artifacts/value-bets/e2e/screenshots.py carpeta_salida
```
