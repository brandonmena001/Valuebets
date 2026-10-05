type PgLike = { code?: unknown; detail?: unknown; constraint?: unknown; column?: unknown; table?: unknown };

/**
 * Resumen seguro de un error inesperado (red, JSON inválido, base de datos...) para mostrarlo
 * en la pantalla de Fuentes y en los logs. Quita URLs, parámetros de clave y credenciales.
 * En errores de consulta de Drizzle ("Failed query: ...") descarta el SQL y muestra la causa
 * real de Postgres (mensaje, código, restricción y columna), que es lo que permite diagnosticar.
 */
export function describeError(error: unknown, secrets: Array<string | undefined> = []): string {
  if (!(error instanceof Error)) return "";
  const cause = (error as { cause?: unknown }).cause;
  const isQuery = /^Failed query/i.test(error.message);
  let text: string;
  if (isQuery && cause instanceof Error) {
    const pg = cause as Error & PgLike;
    const extras = [pg.code, pg.constraint && `restricción ${String(pg.constraint)}`, pg.column && `columna ${String(pg.column)}`, pg.detail]
      .filter(Boolean)
      .map(String);
    text = ["Base de datos", cause.message, ...extras].join(": ");
  } else if (isQuery) {
    text = "Base de datos: consulta fallida";
  } else {
    const causeText =
      cause instanceof Error
        ? String((cause as PgLike).code ?? cause.message)
        : typeof cause === "string" ? cause : "";
    text = [error.name, error.message, causeText].filter(Boolean).join(": ");
  }
  for (const secret of secrets) if (secret) text = text.split(secret).join("[credencial]");
  return text
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/([?&](?:apiKey|api_key|token|key)=)[^&\s]+/gi, "$1[redactado]")
    .replace(/\s+/g, " ")
    .slice(0, 260);
}
