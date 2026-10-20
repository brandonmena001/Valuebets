/**
 * Ejecuta la compuerta del proyecto. Pensado para correr en Replit (que sí llega a football-data.co.uk):
 *
 *   pnpm --filter @workspace/scripts run gate
 *   pnpm --filter @workspace/scripts run gate -- --leagues=E0,SP1,D1 --seasons=2526,2425,2324
 *   pnpm --filter @workspace/scripts run gate -- --offline ./mis-csv        (sin descargar)
 *
 * Opciones: --leagues=E0,SP1,D1,I1,F1 (o all-main)  --seasons=2627,2526,2425,2324  --cache=ruta
 *           --step-days=7  --burnin-days=300  --out=ruta.md  --offline
 * Cortesía con el sitio: caché de 12 h, If-Modified-Since, 2,5 s entre peticiones, User-Agent propio
 * y parada completa ante 429/403/5xx (usa lo ya descargado).
 */
import fs from "node:fs";
import path from "node:path";
import { currentSeasonStartYear, seasonCode } from "../../artifacts/api-server/src/services/football-data-parse";
import { evaluate, readRows, referenceBacktest, renderReport, walkForward, type Row } from "./gate-lib";

const BASE_URL = process.env.FOOTBALL_DATA_BASE_URL ?? "https://football-data.co.uk";
const UA = "Valuebets-research/1.0 (uso personal sin fines comerciales; https://github.com/brandonmena001/Valuebets)";
const CACHE_TTL_MS = 12 * 3_600_000;
const PAUSE_MS = 2500;
const MAIN = "E0,E1,SC0,D1,I1,SP1,F1,N1,B1,P1,T1,G1";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const has = (name: string) => args.includes(`--${name}`);
const positional = args.filter((a) => !a.startsWith("--"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type State = { blocked: boolean; requests: number; consecutiveFailures: number };

const TIMEOUT_MS = Number(process.env.GATE_TIMEOUT_MS ?? 60_000);
const RETRY_WAITS = (process.env.GATE_RETRY_WAIT_MS ?? "8000,20000").split(",").map(Number);
const PAUSE = Number(process.env.GATE_PAUSE_MS ?? PAUSE_MS);

/**
 * Descarga un archivo con cortesía. Solo un 429/403/5xx detiene TODAS las descargas (el sitio pidió
 * pausa). Un timeout o un fallo de red es transitorio: se reintenta con espera creciente y, si sigue
 * fallando, solo se omite ESE archivo; tres archivos seguidos fallidos sí detienen el resto.
 */
async function download(url: string, file: string, state: State): Promise<string> {
  const exists = fs.existsSync(file);
  if (exists && Date.now() - fs.statSync(file).mtimeMs < CACHE_TTL_MS) return "caché";
  if (state.blocked) return exists ? "caché (descargas detenidas)" : "omitido (descargas detenidas)";
  if (state.requests > 0) await sleep(PAUSE);
  state.requests += 1;
  const headers: Record<string, string> = { "User-Agent": UA };
  if (exists) headers["If-Modified-Since"] = fs.statSync(file).mtime.toUTCString();
  let lastError = "desconocido";
  for (let attempt = 0; attempt <= RETRY_WAITS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_WAITS[attempt - 1]!);
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      state.consecutiveFailures = 0;
      if (res.status === 304) {
        fs.utimesSync(file, new Date(), new Date());
        return "sin cambios";
      }
      if (res.status === 404) return "no existe";
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        state.blocked = true;
        return `HTTP ${res.status}: el sitio pidió pausa, detengo las descargas`;
      }
      if (!res.ok) return `HTTP ${res.status}`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, await res.text());
      return attempt > 0 ? `descargado (a la ${attempt + 1}ª)` : "descargado";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "desconocido";
    }
  }
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= 3) state.blocked = true;
  const suffix = exists ? "uso la caché" : "omitido";
  return `falló tras ${RETRY_WAITS.length + 1} intentos (${lastError}): ${suffix}${state.blocked ? "; 3 fallos seguidos, detengo las descargas" : ""}`;
}

async function main() {
  const rows: Row[] = [];
  let files = 0;
  const readFile = (file: string, league: string, season: string) => {
    const parsed = readRows(fs.readFileSync(file, "utf8"), league, season);
    if (parsed.length) {
      rows.push(...parsed);
      files += 1;
    }
    return parsed.length;
  };

  if (positional.length) {
    for (const target of positional) {
      const list = fs.statSync(target).isDirectory()
        ? fs.readdirSync(target).filter((f) => f.toLowerCase().endsWith(".csv")).map((f) => path.join(target, f))
        : [target];
      for (const file of list) {
        const m = /^([A-Za-z0-9]+)[_\- ](\d{4})/.exec(path.basename(file));
        readFile(file, m?.[1] ?? path.basename(file, ".csv"), m?.[2] ?? "0000");
      }
    }
  } else {
    const cache = path.resolve(flag("cache") ?? ".cache/football-data");
    const start = currentSeasonStartYear();
    const seasons = (flag("seasons") ?? [0, 1, 2, 3].map((i) => seasonCode(start - i)).join(",")).split(",");
    const leagueArg = flag("leagues") ?? "E0,SP1,D1,I1,F1";
    const leagues = (leagueArg === "all-main" ? MAIN : leagueArg).split(",");
    const state: State = { blocked: false, requests: 0, consecutiveFailures: 0 };
    let expected = 0;
    for (const league of leagues) {
      for (const season of seasons) {
        const file = path.join(cache, season, `${league}.csv`);
        const url = `${BASE_URL}/mmz4281/${season}/${league}.csv`;
        expected += 1;
        const status = has("offline") ? (fs.existsSync(file) ? "caché" : "omitido (--offline)") : await download(url, file, state);
        const n = fs.existsSync(file) ? readFile(file, league, season) : 0;
        console.log(`${league} ${season}: ${status}${n ? ` · ${n} partidos` : ""}`);
      }
    }
    console.log(`\nArchivos con datos: ${files} de ${expected}.${files < expected ? " Faltan archivos: vuelve a correr el comando; lo ya descargado queda en caché y continúa donde se quedó." : ""}`);
  }

  if (!rows.length) {
    console.error("No se pudo leer ningún partido. Revisa la conexión o pasa carpetas con CSV.");
    process.exit(1);
  }
  const stepDays = Number(flag("step-days") ?? 7);
  const burnInDays = Number(flag("burnin-days") ?? 300);
  console.log(`\nEjecutando walk-forward sobre ${rows.length} partidos (paso ${stepDays} días)…`);
  const preds = walkForward(rows, { stepDays, burnInDays });
  const result = evaluate(preds);
  const reference = referenceBacktest(rows);
  const report = renderReport(result, { generatedAt: new Date().toISOString(), files }, reference);
  const out = path.resolve(flag("out") ?? "../docs/resultado-backtest.md");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, report);
  console.log(`\nVEREDICTO: ${result.verdict}`);
  for (const reason of result.verdictReasons) console.log(`- ${reason}`);
  console.log(`\nMODO REFERENCIA (comparar casas entre sí, sin modelo): ${reference.headline.verdict}`);
  console.log(`- ${reference.headline.reason}`);
  console.log(`\nInforme completo: ${out}`);
  if (result.verdict === "datos insuficientes") process.exit(2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
