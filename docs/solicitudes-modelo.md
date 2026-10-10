# Solicitudes del rol modelo (chat-modelo) al supervisor

Cambios que necesito en archivos que NO son míos. No los apliqué.

## 1. `scripts/tsconfig.json` — typecheck roto por el backtest (BLOQUEA `pnpm run typecheck` raíz)

`scripts/src/backtest.ts` importa el modelo de `artifacts/api-server/src/...`. El `tsconfig` de `scripts` tiene `rootDir: "src"` y tsc responde TS6059 ("file is not under rootDir"). Los comandos de prueba (`tsx`) funcionan; solo falla `tsc` de `scripts`, que corre dentro de `pnpm run typecheck` / `pnpm run build`.

Cambio exacto en `scripts/tsconfig.json`, dentro de `compilerOptions`: **borrar** la línea `"rootDir": "src",` (o cambiarla a `"rootDir": ".."`). El paquete solo hace `--noEmit`, así que no afecta a ninguna salida.

Verificado: `cd scripts && pnpm exec tsc -p tsconfig.json --noEmit --rootDir ..` termina sin errores.

## 2. `scripts/package.json` — atajo opcional

Agregar en `"scripts"`: `"backtest": "tsx ./src/backtest.ts"`. Sin esto se usa:
`pnpm --filter @workspace/scripts exec tsx src/backtest.ts <carpeta-csv> [--step-days=7] [--burnin-days=300] [--holdout=0.35] [--out=informe.md]`

## 3. Contrato de la ficha de partido: probabilidad mezclada con el mercado

`buildMatchSnapshot` (ya cambiado en `artifacts/api-server/src/model/predict.ts`) acepta ahora `quotes?: QuoteInput[]` y `match.id?`, y devuelve un campo nuevo `blended` (`null` si no hay cuotas o no hay consenso de al menos `minBookmakers` = 3 casas). Los campos existentes (`result`, `btts`, `goalLines`, ...) siguen siendo del modelo puro y NO cambian.

### 3a. `artifacts/api-server/src/routes/data.ts` (~línea 356)

Pasar las cuotas que la ruta ya carga (`quoteRows` es compatible con `QuoteInput`; `row.match` ya trae `id`):

```ts
? buildMatchSnapshot({
    history: await loadFinishedHistory(new Date()),
    match: row.match,
    now: new Date(),
    quotes: quoteRows,
  })
```

Nota: `quoteRows` tiene `.limit(500)` ordenado por `capturedAt` desc; si un partido tiene muchas selecciones, las más viejas de alguna casa pueden quedar fuera y el consenso usar menos casas (solo reduce, no inventa).

### 3b. `lib/api-spec/openapi.yaml`, schema `MatchModel`

Agregar la propiedad (NO en `required`, para no romper clientes) y luego regenerar con `pnpm --filter @workspace/api-spec run codegen`:

```yaml
        blended:
          description: >
            Probabilidades ya mezcladas con el consenso del mercado (cuotas sin margen, mediana entre casas).
            null si no hay cuotas recientes o menos de 3 casas con el mercado completo.
            Mismo peso modelo/mercado que usan las value bets.
          oneOf:
            - type: "null"
            - type: object
              properties:
                result:
                  oneOf:
                    - type: "null"
                    - type: object
                      properties:
                        probs:   { $ref: "#/components/schemas/ResultProbs" }
                        market:  { $ref: "#/components/schemas/ResultProbs" }
                        modelWeight: { type: number, minimum: 0, maximum: 1 }
                        bookmakers:  { type: integer }
                      required: [probs, market, modelWeight, bookmakers]
                btts:
                  oneOf:
                    - type: "null"
                    - type: object
                      properties:
                        yes:       { type: number, minimum: 0, maximum: 1 }
                        marketYes: { type: number, minimum: 0, maximum: 1 }
                        modelWeight: { type: number, minimum: 0, maximum: 1 }
                        bookmakers:  { type: integer }
                      required: [yes, marketYes, modelWeight, bookmakers]
                goalLines:
                  type: array
                  items:
                    type: object
                    properties:
                      line:        { type: number }
                      over:        { type: number, minimum: 0, maximum: 1 }
                      marketOver:  { type: number, minimum: 0, maximum: 1 }
                      modelWeight: { type: number, minimum: 0, maximum: 1 }
                      bookmakers:  { type: integer }
                    required: [line, over, marketOver, modelWeight, bookmakers]
              required: [result, btts, goalLines]
```

`ResultProbs` = `{ home: number, draw: number, away: number }` (todos requeridos); puede ser un schema nuevo o repetir el objeto de `result` que ya existe en `MatchModel`.

Importante: `GetMatchDetailResponse.parse({ model, ... })` es de Zod y por defecto ELIMINA claves desconocidas; mientras el spec no tenga `blended`, la API no lo expondrá aunque el modelo lo calcule. Sin `quotes` en 3a, `blended` siempre es `null`.

### 3c. Frontend (`artifacts/value-bets/**`)

Cuando `model.blended` no sea null, mostrar `blended.result.probs` en lugar de `model.result` como "probabilidad estimada" (y dejar `model.result` como "modelo puro"). `modelWeight` indica cuánto pesa el modelo (≤ 0.35 en 1X2).

## 4. Valores de salida nuevos en `prediction_log.outcome` (sin migración)

La columna ya es `text`. Además de `win | loss | void`, `settleOutcome` puede escribir ahora `push`, `half-win` y `half-loss` (líneas enteras y de cuarto, hándicap asiático). Nada en `routes/**` ni en el frontend lee `outcome` (revisado con grep), pero si alguna pantalla lo hace en el futuro debe tratar esos tres valores. `getModelPerformance` ya los maneja (ROI con ganancia parcial; acierto y Brier solo sobre win/loss).

## 5. Hándicap asiático: formato de línea del proveedor (NO verificado)

Supuesto en `markets.ts`: `line` es el hándicap del LOCAL en ambas selecciones (home -0.5 y away con la misma línea -0.5). Si OddsPapi entrega a cada selección su propia línea (visitante +0.5), las dos patas no se emparejan y el mercado se ignora (falla en seguro, no genera value bets). Necesito una muestra real de `odds_quotes` de un "Asian Handicap" (marketName, selection, line, upstreamMarketId) para confirmar o ajustar. Idem para "Both Teams To Score" (nombre exacto y selecciones Yes/No) y la categoría (`marketCategory`) con la que el colector los guarda.
