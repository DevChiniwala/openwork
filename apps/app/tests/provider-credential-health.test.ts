import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createJSONStorage } from "zustand/middleware";
import { isProviderCredentialRejection } from "../src/react-app/domains/session/sync/session-error";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { credentialHealthKey, useProviderCredentialHealth } = await import("../src/react-app/domains/connections/provider-auth/credential-health");
const { __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest } = await import("../src/react-app/domains/session/sync/session-sync");
const { useSessionActivityStore } = await import("../src/react-app/domains/session/status/session-activity-store");
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });

const workspace = "workspace-fixture";
const provider = "openrouter";
const key = credentialHealthKey(workspace, provider);
let now = 100;
let stored = "";
const clock = () => now;

beforeEach(() => {
  now = 100;
  stored = "";
  spyOn(Date, "now").mockImplementation(clock);
  useProviderCredentialHealth.persist.setOptions({ storage: createJSONStorage(() => ({
    getItem: () => stored || null,
    setItem: (_key, value) => { stored = value; },
    removeItem: () => { stored = ""; },
  })) });
  useProviderCredentialHealth.setState({ entries: {}, revisions: {}, configurations: {} });
});
afterEach(() => { mock.restore(); });

function health() { return useProviderCredentialHealth.getState().entries[key]?.status ?? "unverified"; }

test("a saved key is unverified, rejected after an authentication failure, verified only after success", () => {
  const state = useProviderCredentialHealth.getState();
  state.changed(workspace, provider);
  expect(health()).toBe("unverified");
  now++;
  state.observe(workspace, provider, "rejected", now);
  expect(health()).toBe("rejected");
  now++;
  state.observe(workspace, provider, "verified", now);
  expect(health()).toBe("verified");
  now++;
  state.observe(workspace, provider, "rejected", now);
  expect(health()).toBe("rejected");
  now++;
  state.changed(workspace, provider);
  expect(health()).toBe("unverified");
});

test("an old in-flight request cannot reject or verify a replacement key", () => {
  const state = useProviderCredentialHealth.getState();
  const startedAt = now;
  now++;
  state.changed(workspace, provider);
  state.observe(workspace, provider, "rejected", startedAt);
  state.observe(workspace, provider, "verified", startedAt);
  expect(health()).toBe("unverified");
  state.observe(workspace, provider, "verified", now);
  expect(health()).toBe("unverified");
});

test("a failure is specific to the runtime provider and workspace", () => {
  useProviderCredentialHealth.getState().observe(workspace, provider, "rejected", now);
  expect(health()).toBe("rejected");
  expect(useProviderCredentialHealth.getState().entries[credentialHealthKey(workspace, "anthropic")]).toBeUndefined();
  expect(useProviderCredentialHealth.getState().entries[credentialHealthKey("other-workspace", provider)]).toBeUndefined();
});

test("a changed organization configuration clears evidence, but refresh does not", () => {
  const state = useProviderCredentialHealth.getState();
  state.configure(workspace, provider, "version-1");
  state.observe(workspace, provider, "rejected", now);
  state.configure(workspace, provider, "version-1");
  expect(health()).toBe("rejected");
  now++;
  state.configure(workspace, provider, "version-2");
  expect(health()).toBe("unverified");
});

test("rejection survives a reload without storing any raw error or credential", async () => {
  useProviderCredentialHealth.getState().observe(workspace, provider, "rejected", now);
  const snapshot = stored;
  useProviderCredentialHealth.setState({ entries: {}, revisions: {}, configurations: {} });
  stored = snapshot;
  await useProviderCredentialHealth.persist.rehydrate();
  expect(health()).toBe("rejected");
  expect(JSON.parse(snapshot).state).toEqual({ entries: { [key]: { status: "rejected", revision: 0 } }, revisions: {}, configurations: {} });
});

for (const error of [
  { name: "APIError", data: { statusCode: 401, message: "User not found.", responseBody: '{"error":{"message":"User not found.","code":401}}' } },
  { name: "UnknownError", data: { message: "Provider request failed with HTTP 401: User not found." } },
  { name: "APIError", data: { message: "Invalid API key" } },
  { name: "APIError", data: { responseBody: '{"error":{"code":"invalid_api_key"}}' } },
]) test(`recognized inference rejection: ${JSON.stringify(error)}`, () => {
  expect(isProviderCredentialRejection(error)).toBe(true);
});

for (const error of [
  { name: "APIError", data: { statusCode: 403, message: "Access denied" } },
  { name: "APIError", data: { statusCode: 429, message: "Invalid API key" } },
  { name: "APIError", data: { statusCode: 500, message: "Invalid API key" } },
  { name: "APIError", data: { statusCode: 401, responseBody: '{"error":{"code":"openwork_auth_required"}}' } },
  { name: "APIError", data: { message: "ECONNRESET" } },
  { name: "TimeoutError", data: { message: "Request timed out" } },
  { name: "MessageAbortedError" },
  { name: "ProviderAuthError", data: { message: "Missing API key" } },
  { name: "APIError", data: { message: "An unrelated error mentioning an invalid API key in prose" } },
]) test(`not upstream credential rejection: ${JSON.stringify(error)}`, () => {
  expect(isProviderCredentialRejection(error)).toBe(false);
});

for (const providerId of ["openrouter", "ipr_fixture"]) test(`native lifecycle updates only the provider that actually ran: ${providerId}`, () => {
  const sync = { workspaceId: workspace, baseUrl: "http://127.0.0.1:9/w/fixture/opencode2", openworkToken: "synthetic-local-token" };
  spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: [] }));
  useSessionActivityStore.setState({ recordsByWorkspaceId: {} });
  const dispose = __createWorkspaceSessionSyncForTest(sync);
  const sessionID = "session-fixture";
  const evidenceKey = credentialHealthKey(workspace, providerId);
  try {
    __applySessionSyncEventForTest(sync, { type: "session.execution.started", properties: { sessionID, model: { providerID: providerId, id: "http-401" } } });
    __applySessionSyncEventForTest(sync, { type: "session.execution.failed", properties: { sessionID, error: { name: "APIError", data: { statusCode: 401, message: "User not found." } } } });
    expect(useProviderCredentialHealth.getState().entries[evidenceKey]?.status).toBe("rejected");
    // A following idle is not proof of success.
    __applySessionSyncEventForTest(sync, { type: "session.status", properties: { sessionID, status: { type: "idle" } } });
    expect(useProviderCredentialHealth.getState().entries[evidenceKey]?.status).toBe("rejected");
    now++;
    __applySessionSyncEventForTest(sync, { type: "session.execution.started", properties: { sessionID, model: { providerID: providerId, id: "ok" } } });
    __applySessionSyncEventForTest(sync, { type: "session.execution.succeeded", properties: { sessionID } });
    expect(useProviderCredentialHealth.getState().entries[evidenceKey]?.status).toBe("verified");
    expect(useProviderCredentialHealth.getState().entries[credentialHealthKey(workspace, "unrelated")]).toBeUndefined();
  } finally { dispose(); }
});
