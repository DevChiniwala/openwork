import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEngineV2Preview } from "../src/engine-v2-preview.js";
import { writeGlobalRuntimeOpencodeConfig } from "../src/runtime-opencode-config-store.js";
import type { ServerConfig } from "../src/types.js";

// Exercise the real preview/reconciliation boundary without starting a model,
// an actual MCP transport, or a desktop window.
const fakeEngine = `#!${process.execPath}
const registered = new Map();
const mutations = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/api/info") return Response.json({ version: "2.0.26", pid: process.pid });
  if (path === "/api/model") return Response.json({ data: [] });
  if (path === "/test/mutations") return Response.json(mutations);
  if (path === "/api/mcp") return Response.json({ data: [...registered.keys()].map(name => ({ name, status: { status: "connected" } })) });
  const name = decodeURIComponent(path.split("/").at(-1));
  if (path.startsWith("/api/experimental/mcp/") && request.method === "PUT") {
    const body = await request.json();
    mutations.push({ method: "PUT", name, config: body.config });
    if (name.includes("private-workspace")) return new Response(null, { status: 503 });
    registered.set(name, body.config);
    return new Response(null, { status: 204 });
  }
  if (path.startsWith("/api/experimental/mcp/") && request.method === "DELETE") {
    mutations.push({ method: "DELETE", name });
    registered.delete(name);
    return new Response(null, { status: 204 });
  }
  return new Response(null, { status: 404 });
}});
console.log("server listening on http://127.0.0.1:" + server.port);
`;

test("V2 reconciliation scopes protocol auto to managed Connect and fingerprints replacements", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-v2-mcp-reconcile-"));
  const binary = join(root, "fake-engine");
  const environment = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"),
    OPENWORK_OPENCODE2_BIN: binary,
  };
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  const remote = { type: "remote", url: "https://connect.example.test/mcp/agent", oauth: false,
    headers: { Authorization: "Bearer synthetic-test-token" } };
  // Connect alone is told that the v2 engine lists organization skills natively.
  const connect = (value: typeof remote) => ({ ...value, protocol: "auto",
    headers: { ...value.headers, "x-openwork-mcp-client-capabilities": "native-skills-v1" } });
  const preview = createEngineV2Preview({ config, deferStart: true, waits: { workspaceProviderReadyMs: 0 } });
  try {
    await mkdir(environment.XDG_CONFIG_HOME);
    await writeFile(binary, fakeEngine, { mode: 0o700 });
    await writeGlobalRuntimeOpencodeConfig(config, () => ({ mcp: { "openwork-cloud": remote, generic: remote } }));
    preview.start();
    const deadline = Date.now() + 10_000;
    while (!preview.status().running && !preview.status().lastError && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(preview.status().running, true, preview.status().lastError);
    const connection = preview.connection();
    assert.ok(connection);
    const mutations = async () => {
      const response = await fetch(`${connection.url}/test/mutations`, { headers: {
        authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
      } });
      return response.json();
    };
    const directory = join(root, "workspace");
    await preview.syncWorkspaceMcp("workspace", directory);
    // Independent registrations may be read from the runtime store in either
    // order. Assert both complete payloads, without prescribing their order.
    assert.deepEqual(new Set(await mutations()), new Set([
      { method: "PUT", name: "openwork-cloud", config: connect(remote) },
      { method: "PUT", name: "generic", config: remote },
    ]));
    await preview.syncWorkspaceMcp("workspace", directory);
    assert.equal((await mutations()).length, 2, "healthy unchanged registrations are not restarted");

    const rotated = { ...remote, headers: { Authorization: "Bearer rotated-test-token" } };
    await writeGlobalRuntimeOpencodeConfig(config, () => ({ mcp: {
      "openwork-cloud": rotated,
      generic: { ...remote, protocol: "auto", unsupported: true },
    } }));
    await preview.syncWorkspaceMcp("workspace", directory);
    assert.deepEqual((await mutations()).slice(2), [
      { method: "DELETE", name: "openwork-cloud" },
      { method: "PUT", name: "openwork-cloud", config: connect(rotated) },
    ], "mapped credential changes replace Connect, while unsupported generic fields do not change its fingerprint");

    const privateName = "/Users/synthetic/private-workspace/mcp-server";
    await writeGlobalRuntimeOpencodeConfig(config, () => ({ mcp: { [privateName]: remote } }));
    await preview.syncWorkspaceMcp("workspace", directory);
    const warning = preview.status().lastWarning;
    assert.ok(warning, "a rejected MCP registration is still reported in status");
    assert.match(warning, /An MCP connection needs upkeep; requests can continue\.$/);
    assert.ok(!warning.includes(privateName), "client-readable status must not expose local paths from raw upkeep warnings");
    assert.ok(!warning.includes("503"), "raw upstream diagnostics stay out of the public warning");

    // This fixture has no /api/provider catalog, forcing the real bounded
    // readiness timeout whose raw warning contains the requested directory.
    const privateDirectory = join(root, "private-workspace");
    await preview.ensureWorkspaceReady(privateDirectory);
    const providerWarning = preview.status().lastWarning;
    assert.ok(providerWarning);
    assert.match(providerWarning, /Provider catalog refresh did not finish in time; serving the engine's catalog\.$/);
    assert.ok(!providerWarning.includes(privateDirectory), "provider timeout status must not expose the workspace directory");
    assert.ok(!providerWarning.includes(root), "status must not expose the host's temporary storage path");
  } finally {
    await preview.stop();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
