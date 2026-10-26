import assert from "node:assert/strict";
import test from "node:test";
import type { ServerConfig } from "../src/types.js";
import { listOpenV2Sessions, postWorkerActivityHeartbeat } from "../src/worker-activity-heartbeat.js";

const config = { enabled: true, workerId: "worker", url: "https://den.invalid/heartbeat", token: "secret", intervalMs: 1000, activeWindowMs: 1000 };

test("heartbeat payload stays unchanged and a legacy engine policy in the reply is ignored", async () => {
  const payload = await postWorkerActivityHeartbeat({ config, sessions: [], now: () => 123,
    fetchImpl: async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { sentAt: new Date(123).toISOString(), isActiveRecently: false, lastActivityAt: null, openSessionCount: 0 });
      return Response.json({ ok: true, enginePolicy: { upgrade: true } });
    },
  });
  assert.deepEqual(payload, { sentAt: new Date(123).toISOString(), isActiveRecently: false, lastActivityAt: null, openSessionCount: 0 });
});

test("empty legacy responses are accepted", async () => {
  const payload = await postWorkerActivityHeartbeat({ config, sessions: [], fetchImpl: async () => new Response(null, { status: 204 }) });
  assert.equal(payload?.openSessionCount, 0);
});

test("open sessions are read natively from OpenCode v2 for every local workspace", async () => {
  const serverConfig: Pick<ServerConfig, "workspaces"> = {
    workspaces: [
      { id: "a", name: "A", path: "/tmp/a", preset: "starter", workspaceType: "local" },
      { id: "b", name: "B", path: "/tmp/b", preset: "starter", workspaceType: "local" },
    ],
  };
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const sessions = await listOpenV2Sessions(serverConfig, { url: "http://127.0.0.1:4096", username: "opencode", password: "pw" }, async (input, init) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    const directory = new URL(url).searchParams.get("location[directory]");
    return Response.json({ data: directory === "/tmp/a"
      ? [{ id: "s1", time: { created: 1, updated: 2 } }, { info: { id: "s2", time: { created: 3 } } }]
      : [{ id: "s1", time: { created: 1, updated: 2 } }] });
  });
  assert.equal(sessions.length, 2);
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[0]!.url).pathname, "/api/session");
  assert.equal(new URL(requests[0]!.url).searchParams.get("limit"), "200");
  assert.equal(requests[0]!.authorization, `Basic ${Buffer.from("opencode:pw").toString("base64")}`);
  assert.deepEqual(await listOpenV2Sessions(serverConfig, undefined), []);
});
