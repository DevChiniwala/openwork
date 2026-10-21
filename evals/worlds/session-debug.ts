import { randomUUID } from "node:crypto";
import { eventually, type Seed } from "@openwork/env";
import { browserScript } from "@openwork/cdp";

export async function sessionDebug(seed: Seed) {
  const workspacePath = seed.tmpPath("session-debug");
  const token = randomUUID();
  const app = await seed.appWeb({ name: "session-debug", workspacePath, engine: "v2", mouse: true, headless: true,
    env: { OPENWORK_TOKEN: token } });
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
  }, { within: 210_000, intervalMs: 1_000, label: "the provisioned v2 engine is running", until: status => status.running && Boolean(status.version) });
  const workspace = await seed.workspace(app, workspacePath);
  const session = await seed.session(app, { title: "Debug a conversation" });
  // Read the browser's platform, which can differ from the runner's on remote
  // surfaces. This only selects the native shortcut; it does not change app state.
  const paletteShortcut = await seed.evalIn(app, browserScript(() =>
    /Mac/i.test(navigator.platform) ? "Meta+K" : "Control+K", []));
  return { app, workspace, session, paletteShortcut };
}
