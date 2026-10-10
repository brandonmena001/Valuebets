# Solicitudes del chat de interfaz (rama `chat-interfaz`)

Cambios que necesito en zonas que no son mías. No los he hecho.

## 1. Collector: publicar el estado de football-data (Chat 1)

- **Archivo:** `artifacts/api-server/src/services/collector.ts` (propiedad de servicios).
- **Cambio exacto:**
  1. Ampliar `ProviderName` con `"football-data"` (hoy es `"api-football" | "oddspapi"`).
  2. En `getProviderStatusRows()` añadir `ensureSourceRow("football-data")` a la lista de filas aseguradas.
  3. Tras `importFootballData(...)` (línea ~836) escribir en `source_status` para `provider = 'football-data'`: `state` (`ok` / `partial` / `error`), `message` (causa real si falló), `lastAttemptAt`, `lastSuccessAt` y `recordsCollected`.
  4. `providerKeys["football-data"]` no debe marcarlo como `unconfigured` (no necesita clave).
- **Motivo:** el contrato ya acepta `football-data` en `Provider` y la pantalla Fuentes ya tiene su tarjeta. Mientras no exista la fila se muestra «Sin informe todavía».
- **Cuidado:** `/api/sources` valida con zod. Cualquier proveedor fuera del enum (`api-football`, `oddspapi`, `football-data`) haría fallar la respuesta con 500.
- **No** hace falta tocar `POST /sync`: su contrato (`SyncProvider`) sigue limitado a `api-football` y `oddspapi`. Si football-data debe poder sincronizarse a mano, avísame y amplío `SyncProvider`.

## 2. Hándicap asiático y «ambos anotan» (Chat 2)

- Esperando `docs/solicitudes-modelo.md`: **no existe todavía en `modelo-v3`**, así que no he inventado campos.
- «Ambos anotan» ya se muestra con el campo actual `model.btts`.
- Cuando llegue el contrato, bastará añadir un bloque en `pages/match-analysis.tsx` con `PickRow`/`LineTable` (`components/market-blocks.tsx`); `LineTable` ya admite nombres de columna propios y texto de selección propio. Si el hándicap trae probabilidad de «push» (líneas de cuarto), pediré el campo exacto en ese documento.
