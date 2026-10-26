import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApiError } from "../src/errors.js";
import { localProviderRouteResponse } from "../src/opencode-v2-local-provider-routes.js";

const catalog = async () => new Map<string, unknown>([
  ["openrouter", { id: "openrouter", name: "OpenRouter", env: ["OPENROUTER_API_KEY"], npm: "@openrouter/ai-sdk-provider", models: { a: {} } }],
  ["unnamed", { env: "not-a-list" }],
]);

async function withDataHome(run: (authPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "openwork-provider-routes-"));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = directory;
  try { await run(join(directory, "opencode", "auth.json")); }
  finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function call(method: string, restPath: string, body?: unknown, refresh: () => Promise<void> = async () => {}) {
  return localProviderRouteResponse({
    request: new Request(`http://127.0.0.1/workspace/w${restPath}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }),
    restPath, workspacePath: "/tmp/workspace", catalog, ensureWritable: () => {}, refresh,
  });
}

test("saving and removing an API key writes this computer's credential file and refreshes the engine", async () => {
  await withDataHome(async (authPath) => {
    let refreshes = 0;
    const saved = await call("PUT", "/opencode2/auth/openrouter", { type: "api", key: " sk-or-test " }, async () => { refreshes += 1; });
    assert.equal(saved?.status, 200);
    assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), { openrouter: { type: "api", key: "sk-or-test" } });
    const removed = await call("DELETE", "/opencode2/auth/openrouter", undefined, async () => { refreshes += 1; });
    assert.equal(removed?.status, 200);
    assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), {});
    assert.equal(refreshes, 2);
  });
});

test("a save without an API key and provider sign-in are refused clearly", async () => {
  await withDataHome(async () => {
    await assert.rejects(call("PUT", "/opencode2/auth/openrouter", { type: "oauth", refresh: "x" }),
      (error: unknown) => error instanceof ApiError && error.code === "provider_api_key_required");
    await assert.rejects(call("POST", "/opencode2/provider/openai/oauth/authorize", { method: 0 }),
      (error: unknown) => error instanceof ApiError && error.code === "provider_sign_in_unavailable");
  });
});

test("the Connect catalog, sign-in methods and folder come from OpenWork; other routes reach the engine", async () => {
  const list = await call("GET", "/opencode2/provider");
  assert.deepEqual(await list?.json(), {
    all: [
      { id: "openrouter", name: "OpenRouter", env: ["OPENROUTER_API_KEY"], source: "api", options: {}, models: {} },
      { id: "unnamed", name: "unnamed", env: [], source: "api", options: {}, models: {} },
    ],
    connected: [],
    default: {},
  });
  assert.deepEqual(await (await call("GET", "/opencode2/provider/auth"))?.json(), {});
  assert.equal((await (await call("GET", "/opencode2/path"))?.json()).directory, "/tmp/workspace");
  assert.equal(await call("GET", "/opencode2/api/provider"), null);
  assert.equal(await call("GET", "/opencode2/api/session"), null);
});
