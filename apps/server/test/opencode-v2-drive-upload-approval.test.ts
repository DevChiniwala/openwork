import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { renderOpencodeV2Config } from "../src/managed-opencode-v2.js";
import { createV2ContextBridge } from "../src/opencode-v2-context-bridge.js";

type Answer = { effect: "ask" | "allow" | "deny"; reply?: "once" | "always" | "reject" };

/** The engine's permission and event routes, with the person answering each prompt. */
async function fakeEngine(answer: Answer) {
  const asked: Array<{ query: string; body: Record<string, unknown> }> = [];
  const streams = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.headers.authorization !== `Basic ${Buffer.from("opencode:secret").toString("base64")}`) return void response.writeHead(401).end();
    if (request.method === "GET" && url.pathname === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`);
      streams.add(response);
      request.on("close", () => streams.delete(response));
      return;
    }
    let text = "";
    request.on("data", chunk => { text += chunk; });
    request.on("end", () => {
      asked.push({ query: url.search, body: JSON.parse(text) });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { id: "per_one", effect: answer.effect } }));
      if (answer.reply) setTimeout(() => {
        for (const stream of streams) stream.write(`data: ${JSON.stringify({ type: "permission.replied", data: { sessionID: "ses_one", requestID: "per_one", reply: answer.reply } })}\n\n`);
      }, 20);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    asked, connection: { url: `http://127.0.0.1:${port}`, username: "opencode", password: "secret" },
    close: () => { for (const stream of streams) stream.end(); return new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

async function uploadThroughBridge(answer: Answer, caller: Record<string, unknown> | null = { directory: "/work/acme", messageId: "msg_one", callId: "call_one", agent: "build" }) {
  const engine = await fakeEngine(answer);
  const uploads: unknown[] = [];
  const bridge = await createV2ContextBridge(async (path, init) => {
    assert.equal(path, "/experimental/extensions/call");
    uploads.push(JSON.parse(String(init?.body)));
    return { ok: true, fileId: "drive-file-1" };
  }, () => engine.connection);
  try {
    const response = await fetch(bridge.url, {
      method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openwork_drive_upload", input: { path: "proposal.docx", folderId: "folder-1" }, sessionId: "ses_one", ...(caller ? { caller } : {}) }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown>, uploads, asked: engine.asked };
  } finally {
    await bridge.close();
    await engine.close();
  }
}

test("a v2 Drive upload runs only after the person allows that file in the calling chat", async () => {
  const result = await uploadThroughBridge({ effect: "ask", reply: "once" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.asked, [{
    query: `?location[directory]=${encodeURIComponent("/work/acme")}`,
    body: {
      action: "drive_upload_file", resources: ["proposal.docx"], save: [], agent: "build",
      metadata: { path: "proposal.docx", target: "Google Drive folder folder-1" },
      source: { type: "tool", messageID: "msg_one", id: "call_one" },
    },
  }]);
  assert.deepEqual(result.uploads, [{
    extensionId: "openwork-cloud-uploads", action: "drive_upload_file", args: { path: "proposal.docx", folderId: "folder-1" }, context: {},
  }]);
});

test("a declined, pre-allowed, blocked or unaskable v2 Drive upload sends nothing", async () => {
  for (const [answer, message] of [
    [{ effect: "ask", reply: "reject" }, /declined/],
    [{ effect: "allow" }, /not shown to you for approval/],
    [{ effect: "deny" }, /do not allow this upload/],
  ] as const) {
    const result = await uploadThroughBridge(answer);
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), message);
    assert.deepEqual(result.uploads, []);
  }
  const unaskable = await uploadThroughBridge({ effect: "ask", reply: "once" }, null);
  assert.equal(unaskable.status, 400);
  assert.match(String(unaskable.body.error), /cannot ask for your approval/);
  assert.deepEqual([unaskable.asked, unaskable.uploads], [[], []]);
});

test("the engine asks before every context-tool Drive upload instead of allowing it by default", () => {
  const rendered = renderOpencodeV2Config({ providers: [], skills: [], contextPluginDirectory: "/plugins/context", contextTools: { url: "http://127.0.0.1:1/read", token: "t" } });
  assert.deepEqual(rendered.permissions, [{ action: "drive_upload_file", resource: "*", effect: "ask" }]);
  assert.equal(renderOpencodeV2Config({ providers: [], skills: [] }).permissions, undefined);
});
