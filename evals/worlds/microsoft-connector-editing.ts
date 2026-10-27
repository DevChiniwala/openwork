import type { Seed } from "@openwork/env";
import { denFetch, signIn } from "@openwork/behaviors";

export const INITIAL_CLIENT_ID = "11111111-1111-4111-8111-111111111111";
export const INITIAL_TENANT_ID = "22222222-2222-4222-8222-222222222222";
export const CHANGED_CLIENT_ID = "33333333-3333-4333-8333-333333333333";
export const CHANGED_TENANT_ID = "44444444-4444-4444-8444-444444444444";
export const ROTATED_SECRET = "synthetic-m365-rotation-only";
export const EXTERNAL_CLIENT_ID = "55555555-5555-4555-8555-555555555555";
export const EXTERNAL_TENANT_ID = "66666666-6666-4666-8666-666666666666";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read-only CDP witness. Retain field names and HTTP status only, never request values or headers. */
async function observeWrites(debuggerUrl: string | undefined, path: string) {
  if (!debuggerUrl) throw new Error("Credential write observation requires the isolated browser target");
  const writes: Array<{ fields: string[]; status: number | null }> = [];
  const requests = new Map<string, (typeof writes)[number]>();
  const configReads = new Set<string>();
  let completedReads = 0;
  const socket = new WebSocket(debuggerUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Credential write observer did not attach")), 10_000);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Network.enable" })));
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Credential write observer disconnected")); });
      socket.addEventListener("message", (event) => {
        const message: unknown = JSON.parse(String(event.data));
        if (!record(message)) return;
        if (message.id === 1) {
          clearTimeout(timer);
          if (message.error) reject(new Error("Credential write observation failed"));
          else resolve();
        }
        const params = message.params;
        if (!record(params)) return;
        if (message.method === "Network.requestWillBeSent" && record(params.request)) {
          const request = params.request;
          if (typeof request.url !== "string") return;
          const pathname = new URL(request.url).pathname;
          if (pathname !== path && pathname !== `/api/browser${path}`) return;
          if (request.method === "GET" && typeof params.requestId === "string") configReads.add(params.requestId);
          if (request.method !== "POST") return;
          const body: unknown = typeof request.postData === "string" ? JSON.parse(request.postData) : null;
          const write = { fields: record(body) ? Object.keys(body).sort() : [], status: null };
          writes.push(write);
          if (typeof params.requestId === "string") requests.set(params.requestId, write);
        }
        if (message.method === "Network.responseReceived" && typeof params.requestId === "string" && record(params.response)) {
          const write = requests.get(params.requestId);
          if (write && typeof params.response.status === "number") write.status = params.response.status;
          if (configReads.delete(params.requestId) && params.response.status === 200) completedReads++;
        }
      });
    });
    return { writes: () => writes.map((write) => ({ ...write, fields: [...write.fields] })), reads: () => completedReads, close: () => socket.close() };
  } catch (error) { socket.close(); throw error; }
}

async function microsoftWorld(seed: Seed, enabled: boolean) {
  const den = await seed.den({
    org: { name: "Microsoft connector proof", admin: { name: "Workspace Admin" } },
    env: { DEN_FEATURE_MICROSOFT_CONNECTOR_CREDENTIAL_EDITING: String(enabled) },
  });
  const connector = await seed.nativeConnector(den.admin, {
    providerKey: "microsoft-365", name: "Microsoft 365", clientId: INITIAL_CLIENT_ID,
    clientSecret: "synthetic-m365-initial-only", features: ["calendarRead"],
  });
  const path = `/v1/oauth-providers/${encodeURIComponent(connector.id)}/client`;
  const configured = await seed.api(den.admin, path, {
    method: "POST", body: JSON.stringify({ tenantId: INITIAL_TENANT_ID, features: ["calendarRead"] }),
  });
  if (!configured.response.ok) throw new Error(`Microsoft tenant setup failed: HTTP ${configured.response.status}`);
  // A separate signed-in session for the same owner models their other tab/client.
  const otherOwnerSession = await signIn(den.admin, { email: den.admin.email, password: den.admin.password });
  const web = await seed.web({
    den, signedInAs: den.admin, startPath: `/dashboard/mcp-connections/${encodeURIComponent(connector.id)}`,
    headless: true, viewport: { width: 1280, height: 1000 },
  });
  const witness = await observeWrites(web.client.webSocketDebuggerUrl, path);
  return {
    web,
    writes: witness.writes,
    configReads: witness.reads,
    // Explicit concurrent-editor fixture: public API, another authenticated owner session;
    // never a hidden database or renderer-state write. The first tab observes it by normal invalidation.
    changeAppFromOtherOwnerSession: async () => {
      const result = await seed.api(otherOwnerSession, path, {
        method: "POST",
        body: JSON.stringify({ clientId: EXTERNAL_CLIENT_ID, tenantId: EXTERNAL_TENANT_ID, clientSecret: "synthetic-m365-other-session-only", features: ["calendarRead", "mailRead"] }),
      });
      if (!result.response.ok) throw new Error(`Other owner session could not change the app: HTTP ${result.response.status}`);
      return result.response.status;
    },
    // Only the public authenticated GET contract; no credential-store access.
    config: async () => {
      const result = await denFetch(den.admin, path, { headers: { authorization: `Bearer ${den.admin.token}` } });
      if (!result.response.ok || !record(result.body)) throw new Error(`Microsoft config read failed: HTTP ${result.response.status}`);
      const body = result.body;
      return {
        clientId: body.clientId, tenantId: body.tenantId, features: body.features,
        configured: body.configured, secretReturned: Object.keys(body).some((key) => /secret/i.test(key)),
      };
    },
    [Symbol.asyncDispose]: async () => { witness.close(); },
  };
}

export const microsoftConnectorEditing = (seed: Seed) => microsoftWorld(seed, true);
export const microsoftConnectorEditingOff = (seed: Seed) => microsoftWorld(seed, false);
