import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const embeddedUrl = process.env.OPENWORK_TEST_EMBEDDED_MODULE_URL
  || pathToFileURL(join(repo, "apps/server/dist/embedded.js")).href;
const engineBin = process.env.OPENWORK_TEST_ENGINE_BIN
  || join(repo, "apps/desktop/resources/sidecars", process.platform === "win32" ? "opencode2.exe" : "opencode2");

test("a fresh bundled OpenCode v2 engine lists sessions without npm access", { timeout: 60_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "openwork-cold-engine-"));
  const previousEnv = { ...process.env };
  const registryRequests = [];
  // Fault only the dependency registry. The real engine and authenticated
  // OpenWork API must still answer; do not mock their readiness.
  const registry = createServer((request) => registryRequests.push(request.url));
  await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
  let handle;
  try {
    // A shell launched by OpenWork can carry its actual engine DB/config.
    // Clear those before importing any module that caches environment paths.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("OPENCODE_") || key.startsWith("OPENWORK_")) delete process.env[key];
    }
    Object.assign(process.env, {
      HOME: profile, USERPROFILE: profile, OPENCODE_TEST_HOME: profile,
      XDG_CONFIG_HOME: join(profile, "config"), XDG_DATA_HOME: join(profile, "data"),
      XDG_CACHE_HOME: join(profile, "cache"), XDG_STATE_HOME: join(profile, "state"),
      OPENCODE_CONFIG_DIR: join(profile, "engine-config"),
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      // The packaged app hands the server its bundled engine the same way.
      OPENWORK_OPENCODE2_BIN: engineBin,
      OPENWORK_DATA_DIR: join(profile, "openwork"),
      OPENWORK_ENV_STORE: join(profile, "env.json"),
      npm_config_registry: `http://127.0.0.1:${registry.address().port}`,
      npm_config_fetch_retries: "0", npm_config_fetch_timeout: "60000",
    });
    const workspace = join(profile, "workspace");
    for (const path of [join(workspace, ".opencode"), join(profile, ".opencode"), process.env.OPENCODE_CONFIG_DIR]) {
      await mkdir(path, { recursive: true });
    }
    const { startEmbeddedServer } = await import(embeddedUrl);
    handle = await startEmbeddedServer({
      workspaces: [workspace],
      configPath: join(profile, "openwork", "server.json"),
      host: "127.0.0.1", port: 0, token: "cold-engine-owner", hostToken: "cold-engine-host",
    });
    const workspaceId = handle.config.workspaces[0]?.id;
    assert.ok(workspaceId, "the real embedded server registered the workspace");
    const headers = { Authorization: "Bearer cold-engine-owner" };
    // The engine starts in the background after the server binds; until then
    // the proxy answers 503 and clients retry.
    const deadline = Date.now() + 45_000;
    let sessions;
    do {
      sessions = await fetch(`${handle.url}/workspace/${workspaceId}/opencode2/api/session?limit=20`, {
        headers, signal: AbortSignal.timeout(45_000),
      });
      if (sessions.status !== 503) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(sessions.status, 200);
    const body = await sessions.json();
    assert.deepEqual(Array.isArray(body) ? body : body?.data, []);
    const retired = await fetch(`${handle.url}/workspace/${workspaceId}/opencode/session`, {
      headers, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(retired.status, 410, "the removed engine mount answers 410");
    assert.deepEqual(registryRequests, [], "cold startup did not need a registry download");
  } finally {
    await handle?.stop();
    registry.closeAllConnections();
    await new Promise((resolve) => registry.close(resolve));
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    await rm(profile, { recursive: true, force: true });
  }
});
