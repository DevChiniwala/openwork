import assert from "node:assert/strict";
import { test } from "node:test";
import { assignedConnectorForLibrary, personalConnectorDisconnectLabel } from "./connector-library-navigation";
import type { ExternalMcpConnection } from "./mcp-connections-data";

function connection(overrides: Partial<ExternalMcpConnection> = {}): ExternalMcpConnection {
  return {
    id: "emc_notes", name: "Notes", url: "https://notes.example.test/mcp", authType: "oauth", credentialMode: "per_member",
    apiKeyAuthScheme: "bearer", exposeDirectly: false, connected: true, connectedAt: null, updatedAt: null,
    connectedForMe: true, requiredBy: [], identityManagedBy: [], access: null, ...overrides,
  };
}

test("Library navigation requires a server usable grant and the rollout", () => {
  const assigned = connection();
  assert.equal(assignedConnectorForLibrary(true, assigned.id, [assigned]), assigned);
  assert.equal(assignedConnectorForLibrary(false, assigned.id, [assigned]), undefined);
  assert.equal(assignedConnectorForLibrary(true, assigned.id, undefined), undefined);
  assert.equal(assignedConnectorForLibrary(true, assigned.id, []), undefined);
  assert.equal(assignedConnectorForLibrary(true, "other", [assigned]), undefined);
});

test("an assigned connector needing sign-in still opens in Library", () => {
  const assigned = connection({ connectedForMe: false });
  assert.equal(assignedConnectorForLibrary(true, assigned.id, [assigned]), assigned);
  assert.equal(personalConnectorDisconnectLabel(assigned), null);
});

test("personal disconnect only touches a connected per-member account", () => {
  assert.equal(personalConnectorDisconnectLabel(connection()), "Sign out");
  assert.equal(personalConnectorDisconnectLabel(connection({ authType: "apikey" })), "Remove key");
  assert.equal(personalConnectorDisconnectLabel(connection({ credentialMode: "shared" })), null);
  assert.equal(personalConnectorDisconnectLabel(connection({ authType: "none" })), null);
  assert.equal(personalConnectorDisconnectLabel(undefined), null);
});

test("management or removal rights alone never expose personal actions", () => {
  const managed = connection({ createdByYou: true, canRemove: true });
  const assigned = assignedConnectorForLibrary(true, managed.id, []);
  assert.equal(assigned, undefined);
  assert.equal(personalConnectorDisconnectLabel(assigned), null);
});
