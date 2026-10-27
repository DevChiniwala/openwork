import type { McpStatusMap } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

/**
 * Map the native `/api/mcp` catalog (`[{ name, status: { status, error? } }]`)
 * onto the name-keyed status map the rest of the app consumes. `pending`
 * servers are omitted so callers treat them as not-yet-known instead of failed.
 */
export function mapV2McpStatuses(payload: unknown): McpStatusMap | null {
  const entries = isRecord(payload) && "data" in payload ? payload.data : payload;
  if (!Array.isArray(entries)) return null;
  const statuses: McpStatusMap = {};
  for (const entry of entries) {
    const name = readString(entry, "name");
    const detail = isRecord(entry) ? entry.status : undefined;
    const status = readString(detail, "status");
    if (!name || !status) continue;
    const error = readString(detail, "error") ?? "MCP connection failed";
    if (status === "connected" || status === "disabled" || status === "needs_auth") statuses[name] = { status };
    else if (status === "failed" || status === "needs_client_registration") statuses[name] = { status, error };
    else if (status !== "pending") statuses[name] = { status: "failed", error: `Unknown MCP status: ${status}` };
  }
  return statuses;
}
