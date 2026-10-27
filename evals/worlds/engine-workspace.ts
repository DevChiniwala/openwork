import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance as nodePerformance } from "node:perf_hooks";
import type { MockHandle, Place, Seed } from "@openwork/env";
import type { MockAgentToolStep, MockAgentWorkload } from "@openwork/labs";
import { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { fileURLToPath } from "node:url";
import { configureProvider } from "./chat.ts";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A JSON response body as a record; throws when the body is not an object. */
export function responseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a response object");
  return Object.fromEntries(Object.entries(value));
}

/** The scripted model every engine workspace chats with; never a hosted or free provider. */
export const WITNESS_PROVIDER_ID = "engine-witness";
export const WITNESS_MODEL_ID = "witness-model";
const WITNESS_MODEL_NAME = "Witness model";

function witnessProvider(mockUrl: string) {
  return { [WITNESS_PROVIDER_ID]: {
    npm: "@ai-sdk/openai-compatible", name: "Engine witness",
    options: { baseURL: `${mockUrl}/v1`, apiKey: "engine-witness-only" },
    models: { [WITNESS_MODEL_ID]: { name: WITNESS_MODEL_NAME, tool_call: true, limit: { context: 128000, output: 8192 } } },
  } };
}

/**
 * Real app, server and OpenCode v2 engine; only the paid model transport is
 * synthetic. The workspace chats with a scripted witness model under its own
 * provider id, selected in the app the way a person's saved choice is.
 */
export async function engineWorkspace(seed: Seed, { place }: { place: Place }, options: { mock?: MockHandle; env?: Record<string, string> } = {}) {
  const nonce = randomUUID();
  const prompt = `Introduce this workspace briefly. WORKSPACE-${nonce}`;
  const reply = `Your workspace is ready. ${nonce}`;
  const temporaryWorkspace = seed.tmpPath("engine-workspace");
  await mkdir(temporaryWorkspace, { recursive: true });
  // macOS aliases /tmp to /private/tmp; the engine reports canonical paths.
  const workspacePath = await realpath(temporaryWorkspace);
  const mock = options.mock ?? (await seed.mock({ isolatedProcessEnv: true }).boot(place)).handle;
  try {
    const configured = await fetch(`${mock.url}/admin/agent-workloads`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workloads: [{ promptMarker: prompt, latestUserTurn: true, finalReply: reply, steps: [] }] }) });
    if (!configured.ok) throw new Error("Could not configure initial model witness");
    await mkdir(workspacePath, { recursive: true });
    const witnessConfig = { permission: { skill: "allow" }, provider: witnessProvider(mock.url) };
    await writeFile(join(workspacePath, "opencode.json"), JSON.stringify({
      ...witnessConfig, model: `${WITNESS_PROVIDER_ID}/${WITNESS_MODEL_ID}`,
    }));
    const startedAt = nodePerformance.now();
    const app = await seed.appWeb({ name: "engine-workspace", workspacePath, env: {
      OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS: "1000",
      OPENWORK_LOG_FORMAT: "json",
      ...(process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {}),
      ...options.env,
    } });
    const interactiveMs = nodePerformance.now() - startedAt;
    const paths = resolveHeadlessWorldRuntimePaths(fileURLToPath(new URL("../../", import.meta.url)), app.handle.name);
    const manifest = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
    if (!manifest) throw new Error("Missing owned app runtime manifest");
    const ownerResponse = await fetch(`${app.openworkUrl}/tokens`, {
      method: "POST", headers: { "X-OpenWork-Host-Token": manifest.hostToken, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "owner", label: "engine-workspace-fixture" }),
    });
    const owner: unknown = await ownerResponse.json();
    if (ownerResponse.status !== 201 || !owner || typeof owner !== "object" || !("token" in owner) || typeof owner.token !== "string") throw new Error("Could not mint fixture owner token");
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${app.openworkUrl}${path}`, {
        method, headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      const value: unknown = text ? JSON.parse(text) : null;
      return { status: response.status, body: value };
    };
    const route = () => seed.evalIn(app, () => location.hash || `#${location.pathname}`);
    /** The workspace the app opened, once it lands on a task. */
    const workspaceId = async () => {
      let observed = "";
      for (const deadline = Date.now() + 90_000; Date.now() < deadline;) {
        observed = await route();
        const id = /\/workspace\/([^/]+)\/session/.exec(observed)?.[1];
        if (id) return id;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(`The app never opened a workspace task; route: ${observed}`);
    };
    /** Select the witness model in the app, as a person's saved choice; repeat after signing in. */
    const selectWitnessModel = async () => {
      await configureProvider(seed, app, await workspaceId(), WITNESS_PROVIDER_ID, WITNESS_MODEL_ID, witnessConfig);
    };
    await selectWitnessModel();
    return {
      app, mock, prompt, reply, interactiveMs, startedAt, workspacePath, request, route, workspaceId, selectWitnessModel,
      providerId: WITNESS_PROVIDER_ID, modelId: WITNESS_MODEL_ID,
      documentIdentity: () => seed.evalIn(app, () => performance.timeOrigin),
      async reloadRequests() {
        const log = await readFile(paths.headlessLogPath, "utf8");
        return log.split("\n").map((line) => {
          try { const entry: unknown = JSON.parse(line); return record(entry) && typeof entry.body === "string" ? entry.body : line; } catch { return line; }
        }).filter((line) => /^POST .*\/(?:engine\/reload|instance\/dispose|global\/dispose)\b/.test(line)
          || line === "Engine rollover requested." || line === "Engine reloaded in place (idle).");
      },
      async serverErrors() {
        const log = await readFile(paths.headlessLogPath, "utf8");
        return log.split("\n").flatMap((line) => {
          try {
            const entry: unknown = JSON.parse(line);
            if (!record(entry) || typeof entry.body !== "string" || !/ 5\d\d /.test(entry.body)) return [];
            const attributes = record(entry.attributes) ? entry.attributes : {};
            return [{ message: entry.body, error: attributes.error, cause: attributes["error.cause"] }];
          } catch { return []; }
        });
      },
      async observeNativeCatalog(workspaceId: string) {
        const abort = new AbortController();
        const events: Array<{ type: string; directory?: string }> = [];
        const response = await fetch(`${app.openworkUrl}/workspace/${workspaceId}/opencode2/api/event`, {
          headers: { Authorization: `Bearer ${owner.token}`, Accept: "text/event-stream" }, signal: abort.signal,
        });
        if (!response.ok || !response.body) throw new Error("Native event observer did not connect");
        const reader = response.body.getReader();
        const reading = (async () => {
          const decoder = new TextDecoder();
          let buffer = "";
          while (!abort.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const event: unknown = JSON.parse(line.slice(5));
              if (!record(event) || (event.type !== "catalog.updated" && event.type !== "config.updated")) continue;
              const location = record(event.location) ? event.location : {};
              events.push({ type: event.type, ...(typeof location.directory === "string" ? { directory: location.directory } : {}) });
            }
          }
        })().catch((error: unknown) => { if (!abort.signal.aborted) throw error; });
        void reading.catch(() => undefined);
        return { events, async stop() { abort.abort(); await reading; } };
      },
      async hostRequest(path: string, method: string, body?: unknown) {
        const response = await fetch(`${app.openworkUrl}${path}`, {
          method, headers: { "X-OpenWork-Host-Token": manifest.hostToken, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
        });
        const text = await response.text();
        const value: unknown = text ? JSON.parse(text) : null;
        return { status: response.status, body: value };
      },
      async prepareTurn(promptMarker: string, finalReply: string, steps: MockAgentToolStep[] = [], finalReplyFrom?: MockAgentWorkload["finalReplyFrom"]) {
        const response = await fetch(`${mock.url}/admin/agent-workloads`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ workloads: [{ promptMarker, latestUserTurn: true, finalReply, steps, finalReplyFrom }] }),
        });
        if (!response.ok) throw new Error(`Model witness setup failed: ${response.status}`);
      },
      async prepareStream(promptMarker: string, chunks: string[]) {
        const response = await fetch(`${mock.url}/admin/agent-workloads`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ workloads: [{ promptMarker, latestUserTurn: true, finalReply: chunks.join(""), steps: [], finalReplyChunks: chunks, finalReplyInitiallyReleasedChunks: 1 }] }),
        });
        if (!response.ok) throw new Error(`Streaming witness setup failed: ${response.status}`);
      },
      async runtime() {
        const { status, body } = await request("/experimental/engine-v2-preview/status");
        if (status !== 200 || !body || typeof body !== "object" || !("chatRouting" in body)) throw new Error("Missing runtime identity");
        if (!("pid" in body) || typeof body.pid !== "number") throw new Error("The engine must report a real process identity");
        return { chatRouting: body.chatRouting === true, pid: "pid" in body ? body.pid : null, version: "version" in body ? body.version : null };
      },
      async [Symbol.asyncDispose]() { if (!options.mock) await mock.stop(); },
    };
  } catch (error) { if (!options.mock) await mock.stop(); throw error; }
}
