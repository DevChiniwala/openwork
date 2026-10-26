import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eventually, type Place, type Seed } from "@openwork/env";
import { browserScript } from "@openwork/cdp";
import { modelRemovalHttpFixture } from "./model-removal-cdp.ts";
import { configureProvider } from "./chat.ts";

export const PRIMARY_PROVIDER_ID = "debug-primary";
export const PRIMARY_MODEL_ID = "primary-model";

export async function sessionDebug(seed: Seed, { place }: { place: Place }) {
  await using setup = new AsyncDisposableStack();
  const workspacePath = seed.tmpPath("session-debug");
  const mock = (await seed.mock({ isolatedProcessEnv: true }).boot(place)).handle;
  setup.defer(() => mock.stop());
  const prompt = "Check this conversation's provider route.";
  const reply = "This conversation reached its configured provider.";
  const configured = await fetch(`${mock.url}/admin/agent-workloads`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workloads: [{ promptMarker: prompt, latestUserTurn: true, finalReply: reply, steps: [] }] }) });
  if (!configured.ok) throw new Error("Could not configure the provider response witness");
  await mkdir(workspacePath, { recursive: true });
  // Real engine configuration; only the paid model HTTP transport is synthetic.
  const primary = { [PRIMARY_PROVIDER_ID]: { name: "Primary provider", npm: "@ai-sdk/openai-compatible",
    options: { baseURL: `${mock.url}/v1`, apiKey: "debug-provider-synthetic-key" },
    models: { [PRIMARY_MODEL_ID]: { name: "Primary model", tool_call: true, limit: { context: 128000, output: 8192 } } } } };
  await writeFile(join(workspacePath, "opencode.json"), JSON.stringify({ model: `${PRIMARY_PROVIDER_ID}/${PRIMARY_MODEL_ID}`, provider: {
    ...primary,
    "debug-secondary": { name: "Secondary provider", npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `${mock.url}/v1`, apiKey: "debug-secondary-synthetic-key" },
      models: { "secondary-model": { name: "Secondary model", limit: { context: 64000, output: 4096 },
        provider: { npm: "@ai-sdk/openai-compatible", api: `${mock.url}/v1` } } } },
  } }));
  const token = randomUUID();
  const app = await seed.appWeb({ name: "session-debug", workspacePath, mouse: true, headless: true,
    env: { OPENWORK_TOKEN: token,
      ...(process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {}),
    } });
  // The native archive installer has a 180-second deadline. Settle that setup
  // before entering the control rail's shorter session-creation deadline.
  await eventually(async () => {
    const response = await fetch(`${app.openworkUrl}/experimental/engine-v2-preview/status`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Engine readiness returned HTTP ${response.status}`);
    const status: unknown = await response.json();
    if (!status || typeof status !== "object") throw new Error("Engine readiness returned an invalid status");
    const version: unknown = Reflect.get(status, "version");
    const lastError: unknown = Reflect.get(status, "lastError");
    return { running: Reflect.get(status, "running") === true,
      version: typeof version === "string" ? version : null,
      lastError: typeof lastError === "string" ? lastError : null };
  }, { within: 210_000, intervalMs: 1_000, label: "the provisioned engine is running", until: status => status.running && Boolean(status.version) });
  const workspace = await seed.workspace(app, workspacePath);
  // Conversations use the scripted primary provider, as a person's saved choice.
  await configureProvider(seed, app, workspace.workspaceId, PRIMARY_PROVIDER_ID, PRIMARY_MODEL_ID, { provider: primary });
  const otherSession = await seed.session(app, { title: "Independent conversation" });
  const session = await seed.session(app, { title: "Debug a conversation" });
  await app.client.send("Browser.grantPermissions", {
    origin: new URL(app.webUrl).origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  // Read the browser's platform, which can differ from the runner's on remote
  // surfaces. This only selects the native shortcut; it does not change app state.
  const paletteShortcut = await seed.evalIn(app, browserScript(() =>
    /Mac/i.test(navigator.platform) ? "Meta+K" : "Control+K", []));
  let healthReads = 0;
  let holdNextHealthRead = false;
  // Hold genuine HTTP reads long enough to witness a loading resource. The
  // response still comes from the real engine; only the transport is delayed.
  const health = setup.use(await modelRemovalHttpFixture(app, [`${new URL(app.openworkUrl).origin}/workspace/*/opencode2/api/info*`], async () => {
    healthReads += 1;
    if (holdNextHealthRead) {
      holdNextHealthRead = false;
      await new Promise(resolve => setTimeout(resolve, 3_000));
    }
    return undefined;
  }));
  const resources = setup.move();
  return { app, workspace, session, otherSession, paletteShortcut, prompt, reply,
    providerReplies: () => mock.agentRequests({ promptMarker: prompt }),
    // Read-only clipboard witness; no renderer state or app APIs are modified.
    readClipboard: () => seed.evalIn(app, browserScript(() => navigator.clipboard.readText(), []), { awaitPromise: true }),
    healthReads: () => { health.check(); return healthReads; },
    holdNextHealthRead: () => { holdNextHealthRead = true; },
    [Symbol.asyncDispose]: () => resources[Symbol.asyncDispose](),
  };
}
