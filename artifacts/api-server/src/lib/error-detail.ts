/**
 * Resumen seguro de un error inesperado (red, JSON inválido, base de datos...) para mostrarlo
 * en la pantalla de Fuentes y en los logs. Quita URLs, parámetros de clave y credenciales.
 */
export function describeError(error: unknown, secrets: Array<string | undefined> = []): string {
  if (!(error instanceof Error)) return "";
  const cause = (error as { cause?: unknown }).cause;
  const causeText =
    cause instanceof Error
      ? String((cause as { code?: unknown }).code ?? cause.message)
      : typeof cause === "string" ? cause : "";
  let text = [error.name, error.message, causeText].filter(Boolean).join(": ");
  for (const secret of secrets) if (secret) text = text.split(secret).join("[credencial]");
  return text
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/([?&](?:apiKey|api_key|token|key)=)[^&\s]+/gi, "$1[redactado]")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}
