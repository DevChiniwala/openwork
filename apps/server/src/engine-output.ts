// Limits are UTF-16 code units, not bytes. Diagnostics must not grow with uptime.
export const ENGINE_OUTPUT_MAX_CHARS = 64 * 1024;
export const ENGINE_STARTUP_LINE_MAX_CHARS = 8 * 1024;

export function appendEngineOutputTail(tail: string, text: string): string {
  if (text.length >= ENGINE_OUTPUT_MAX_CHARS) return text.slice(-ENGINE_OUTPUT_MAX_CHARS);
  return tail.slice(-(ENGINE_OUTPUT_MAX_CHARS - text.length)) + text;
}

// Wait for a newline: even the port in an announcement can span chunks.
export function createEngineStartupLineReader(onLine: (line: string) => void) {
  let listener: typeof onLine | undefined = onLine;
  let pending = "";
  let oversized = false;
  return {
    write(text: string) {
      let start = 0;
      while (listener && start < text.length) {
        const newline = text.indexOf("\n", start);
        const end = newline === -1 ? text.length : newline;
        if (!oversized) {
          if (pending.length + end - start > ENGINE_STARTUP_LINE_MAX_CHARS) {
            // Discard the whole line, not a suffix that could resemble readiness.
            pending = "";
            oversized = true;
          } else {
            pending += text.slice(start, end);
          }
        }
        if (newline === -1) return;
        const line = pending;
        const emit = !oversized;
        pending = "";
        oversized = false;
        if (emit) listener(line);
        start = newline + 1;
      }
    },
    stop() {
      listener = undefined;
      pending = "";
      oversized = false;
    },
  };
}

const ENGINE_LOG_LINE_CHARS = 220;
const ENGINE_LOG_PROBLEM_LINES = 5;

/**
 * Summarizes OpenCode's own log written since one engine launch. Every engine
 * run (v1, v2, version probes) appends to the same opencode.log and tags each
 * line run=<id>, so one line per run shows how far each got, followed by the
 * latest warnings and errors. Startup stdout and stderr are usually empty when
 * an engine stalls; this is the only record of where it stopped.
 */
export function summarizeEngineLog(path: string, text: string, secrets: string[] = []): string {
  const runs = new Map<string, { count: number; first: string; last: string }>();
  const problems: Array<{ run: string; line: string }> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const run = line.match(/\brun=(\S+)/)?.[1] ?? "untagged";
    const entry = runs.get(run) ?? { count: 0, first: line.match(/\btimestamp=(\S+)/)?.[1] ?? "?", last: "" };
    entry.count += 1;
    entry.last = line;
    runs.set(run, entry);
    if (/\blevel=(?:WARN|ERROR)\b|^(?:WARN|ERROR)\s/.test(line)) problems.push({ run, line });
  }
  if (runs.size === 0) return `OpenCode log: nothing written to ${path} since launch`;
  const shorten = (line: string): string => {
    const redacted = secrets.filter(Boolean).reduce((value, secret) => value.split(secret).join("<redacted>"), line);
    const compact = redacted.replace(/\s*\brun=\S+/, "");
    return compact.length > ENGINE_LOG_LINE_CHARS ? `${compact.slice(0, ENGINE_LOG_LINE_CHARS)}…` : compact;
  };
  return [
    `OpenCode log since launch (${path}):`,
    ...[...runs].map(([run, { count, first, last }]) => `run=${run}: ${count} lines from ${first}; last: ${shorten(last)}`),
    ...problems.slice(-ENGINE_LOG_PROBLEM_LINES).map(({ run, line }) => `problem in run=${run}: ${shorten(line)}`),
  ].join("\n");
}
