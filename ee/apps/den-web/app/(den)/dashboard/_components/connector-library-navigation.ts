import type { ExternalMcpConnection } from "./mcp-connections-data";

/** Manage access is not a grant to use a connector. Only trust the usable list. */
export function assignedConnectorForLibrary(
  enabled: boolean,
  connectionId: string,
  usable: readonly ExternalMcpConnection[] | undefined,
): ExternalMcpConnection | undefined {
  return enabled ? usable?.find((connection) => connection.id === connectionId) : undefined;
}

export function personalConnectorDisconnectLabel(connection: ExternalMcpConnection | undefined): "Remove key" | "Sign out" | null {
  if (!connection || connection.credentialMode !== "per_member" || !connection.connectedForMe || connection.authType === "none") return null;
  return connection.authType === "apikey" ? "Remove key" : "Sign out";
}
