/** Redact unregistered credentials too, including truncated JSON error previews. */
export function redactWorkshopDiagnostic(text: string, secrets: readonly string[]): string {
  return secrets.filter(Boolean).reduce((value, secret) => value.replaceAll(secret, "[secret]"), text)
    .replace(/("(?:token|access_token|password|authorization|cookie)"\s*:\s*)("(?:\\.|[^"\\])*"?|[^,}\]\s]+)/gi, '$1"[secret]"')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [secret]")
    .replace(/https?:\/\/[^\s"'<>]+/g, "[private URL]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[secret]");
}
