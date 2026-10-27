import type { UIMessage } from "ai";

export type SessionNotice = {
  id: string;
  source: "subagent" | "shell";
  subjectId: string;
  outcome: "completed" | "error" | "cancelled";
  description: string;
  timestamp: number;
};

/** A stretch of a run spent waiting for the person: a permission or a question. */
export type WaitInterval = { start: number; end?: number };

/** Working time since startedAt, leaving out the time spent waiting for the person. */
export function workingTime(startedAt: number, now: number, waits: readonly WaitInterval[] = []): number {
  let cursor = startedAt;
  let waited = 0;
  for (const wait of [...waits].sort((left, right) => left.start - right.start)) {
    const start = Math.max(cursor, wait.start);
    const stop = Math.min(wait.end ?? now, now);
    waited += Math.max(0, stop - start);
    cursor = Math.max(cursor, stop);
  }
  return Math.max(0, now - startedAt - waited);
}

/** Only native completion notices are visible. Hidden model inputs remain hidden. */
export function sessionNotice(value: unknown, id: string, timestamp: number): SessionNotice | null {
  if (!value || typeof value !== "object") return null;
  const metadata = value as Record<string, unknown>;
  const source = metadata.source;
  const outcome = metadata.state;
  const subjectId = source === "subagent" ? metadata.childID ?? metadata.sessionID : metadata.shellID ?? metadata.jobID;
  if ((source !== "subagent" && source !== "shell") || typeof subjectId !== "string"
    || (outcome !== "completed" && outcome !== "error" && outcome !== "cancelled")) return null;
  return { id, source, subjectId, outcome, timestamp,
    description: typeof metadata.description === "string" ? metadata.description : source === "subagent" ? "Agent" : "Command" };
}

export function reasoningProviderMetadata(part: { id: string; time?: { start: number; end?: number } }) {
  return { opencode: { partId: part.id,
    ...(part.time ? { startedAt: part.time.start, ...(part.time.end === undefined ? {} : { endedAt: part.time.end }) } : {}) } };
}

export function messageNotice(message: UIMessage): SessionNotice | null {
  for (const part of message.parts) {
    if (part.type !== "text") continue;
    const value = part.providerMetadata?.opencode?.notice;
    if (value && typeof value === "object" && "id" in value && typeof value.id === "string"
      && "source" in value && (value.source === "subagent" || value.source === "shell")
      && "subjectId" in value && typeof value.subjectId === "string"
      && "outcome" in value && (value.outcome === "completed" || value.outcome === "error" || value.outcome === "cancelled")
      && "timestamp" in value && typeof value.timestamp === "number" && Number.isFinite(value.timestamp)
      && "description" in value && typeof value.description === "string") return value as SessionNotice;
  }
  return null;
}
