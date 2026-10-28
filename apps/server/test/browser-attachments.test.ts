import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { test } from "node:test";
import { BROWSER_ATTACHMENT_MAX_BYTES, browserAttachmentRequest, readBrowserAttachments } from "../src/browser-attachments.js";
import { server as browserTools } from "../src/opencode-plugins/openwork-chrome-devtools.js";
import type { ServerConfig } from "../src/types.js";
import { managedDesktopPolicy } from "../src/managed-desktop-policy.js";
import { serve } from "../src/serve-node.js";
import { createV2BrowserBridge } from "../src/opencode-v2-browser-bridge.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "browser-attachment-"));
  const config: ServerConfig = { host: "127.0.0.1", port: 8787, token: "client", hostToken: "host", approval: { mode: "auto", timeoutMs: 30_000 }, corsOrigins: [], workspaces: [], authorizedRoots: [root], readOnly: false, startedAt: 0, tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
  return { config, root, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}
const signal = () => new AbortController().signal;

test("attachment rollout is verified afresh and fails closed on missing grant, kill switch and Den failure", async () => {
  await using f = await fixture();
  const previous = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(f.root, "runtime.sqlite");
  let enabled = true;
  let unavailable = false;
  const den = await serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    if (new URL(request.url).pathname === "/v1/org") {
      return unavailable ? new Response(null, { status: 403 }) : Response.json({ features: { browserFileAttachment: enabled } });
    }
    return Response.json({ allowCustomProviders: true });
  } });
  const policy = managedDesktopPolicy({ ...f.config, configPath: join(f.root, "server.json") });
  try {
    assert.equal(await policy.browserFileAttachmentEnabled(), false);
    await policy.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, token: "fixture", orgId: "org_fixture" });
    await policy.current();
    assert.equal(await policy.browserFileAttachmentEnabled(), true);
    enabled = false;
    assert.equal(await policy.browserFileAttachmentEnabled(), false);
    enabled = true;
    assert.equal(await policy.browserFileAttachmentEnabled(), true);
    unavailable = true;
    assert.equal(await policy.browserFileAttachmentEnabled(), false);
    await policy.clearSession();
    assert.equal(await policy.browserFileAttachmentEnabled(), false);
  } finally {
    await den.stop();
    if (previous === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previous;
  }
});

test("attachment reads preserve basename, MIME and exact bytes without returning a path", async () => {
  await using f = await fixture();
  const bytes = Buffer.from([0, 255, 128, 42]);
  await writeFile(join(f.root, "clip.mp4"), bytes);
  const result = await readBrowserAttachments(f.config, ["clip.mp4"], signal());
  assert.deepEqual(result.files, [{ name: "clip.mp4", mimeType: "video/mp4", bytesBase64: bytes.toString("base64") }]);
  assert.equal(JSON.stringify(result).includes(f.root), false);
});

test("a filesystem-root grant preserves the complete requested path", async () => {
  await using f = await fixture();
  await writeFile(join(f.root, "report.txt"), "requested bytes");
  await writeFile(join(f.root, "eport.txt"), "wrong bytes");
  const path = await realpath(join(f.root, "report.txt"));
  const result = await readBrowserAttachments({ ...f.config, authorizedRoots: [parse(path).root] }, [path], signal());
  assert.equal(Buffer.from(result.files[0]?.bytesBase64 ?? "", "base64").toString(), "requested bytes");
});

test("relative paths cannot silently choose another authorized workspace", async () => {
  await using first = await fixture();
  await using second = await fixture();
  await writeFile(join(first.root, "same.txt"), "first");
  await writeFile(join(second.root, "same.txt"), "second");
  const config = { ...first.config, authorizedRoots: [first.root, second.root] };
  await assert.rejects(readBrowserAttachments(config, ["same.txt"], signal()), /absolute attachment path/);
  const result = await readBrowserAttachments(config, ["same.txt"], signal(), second.root);
  assert.equal(Buffer.from(result.files[0]?.bytesBase64 ?? "", "base64").toString(), "second");
  await assert.rejects(readBrowserAttachments(config, ["same.txt"], signal(), "/unapproved"), /outside authorized roots/);
});

test("attachment reads refuse traversal, absolute outside paths, directories and symlinks", async () => {
  await using f = await fixture();
  await writeFile(join(f.root, "file.txt"), "safe");
  await symlink(join(f.root, "file.txt"), join(f.root, "link.txt"));
  for (const path of ["../outside", "/etc/passwd", "link.txt", f.root]) {
    await assert.rejects(readBrowserAttachments(f.config, [path], signal()));
  }
});

test("attachments enforce total byte budget, support empty files and stop on cancellation", async () => {
  await using f = await fixture();
  await writeFile(join(f.root, "empty.txt"), "");
  assert.equal((await readBrowserAttachments(f.config, ["empty.txt"], signal())).files[0]?.bytesBase64, "");
  await writeFile(join(f.root, "large.mp4"), "");
  await truncate(join(f.root, "large.mp4"), BROWSER_ATTACHMENT_MAX_BYTES + 1);
  await assert.rejects(readBrowserAttachments(f.config, ["large.mp4"], signal()), /32 MiB/);
  await assert.rejects(readBrowserAttachments(f.config, ["empty.txt"], AbortSignal.abort()), /abort/i);
});

test("model schema accepts only paths, never payload bytes or caller-supplied roots", () => {
  assert.equal(browserAttachmentRequest.safeParse({ paths: ["clip.mp4"], roots: ["/"] }).success, false);
  assert.equal(browserAttachmentRequest.safeParse({ paths: [] }).success, false);
  assert.equal(browserAttachmentRequest.safeParse({ paths: Array(11).fill("clip.mp4") }).success, false);
});

test("attachment tool requires a requesting conversation and stops when rollout authorization fails", async () => {
  let calls = 0;
  const tools = await browserTools(undefined, async () => { calls++; throw new Error("feature_disabled"); });
  const input = { observationId: "obs", action: { type: "attach_files", ref: "e1", paths: ["clip.mp4"] } };
  assert.match(String(await tools.tool.browser_act.execute(input, {})), /missing_session/);
  assert.equal(calls, 0);
  await assert.rejects(tools.tool.browser_act.execute(input, { sessionID: "test" }), /feature_disabled/);
  assert.equal(calls, 1);
});

test("V1 and V2 send only authorized payloads to the desktop and keep bytes out of tool results", async () => {
  await using f = await fixture();
  const original = { discovery: process.env.OPENWORK_UI_CONTROL_DISCOVERY, url: process.env.OPENWORK_SERVER_URL, token: process.env.OPENWORK_SERVER_TOKEN };
  const calls: unknown[] = [];
  const file = { name: "clip.mp4", mimeType: "video/mp4", bytesBase64: "AP9h" };
  const api = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const path = new URL(request.url).pathname;
    const body: unknown = await request.json();
    if (path === "/experimental/browser/attachments") {
      assert.equal(request.headers.get("authorization"), "Bearer fixture-server");
      assert.deepEqual(body, { paths: ["clip.mp4"], directory: f.root });
      return Response.json({ files: [file] });
    }
    assert.equal(path, "/browser/task");
    assert.equal(request.headers.get("authorization"), "Bearer fixture-desktop");
    calls.push(body);
    return Response.json({ ok: true, dispatched: true, outcome: "verified", files: [{ name: "clip.mp4", size: 3 }] });
  } });
  const url = `http://127.0.0.1:${api.port}`;
  process.env.OPENWORK_UI_CONTROL_DISCOVERY = join(f.root, "bridge.json");
  process.env.OPENWORK_SERVER_URL = url;
  process.env.OPENWORK_SERVER_TOKEN = "fixture-server";
  await writeFile(process.env.OPENWORK_UI_CONTROL_DISCOVERY, JSON.stringify({ baseUrl: url, token: "fixture-desktop" }));
  const input = { tabId: "tab", observationId: "obs", action: { type: "attach_files", ref: "e1", paths: ["clip.mp4"] } };
  const bridge = await createV2BrowserBridge(async (_path, init) => {
    const body: unknown = JSON.parse(String(init?.body));
    assert.deepEqual(body, { paths: ["clip.mp4"] });
    return { files: [file] };
  });
  try {
    const tools = await browserTools({ directory: f.root });
    const direct = await tools.tool.browser_act.execute(input, { sessionID: "v1-session" });
    assert.equal(typeof direct, "string");
    assert.equal(String(direct).includes(file.bytesBase64), false);
    const response = await fetch(bridge.url, { method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "browser_act", input, sessionId: "v2-session" }) });
    assert.equal(response.status, 200);
    assert.equal((await response.text()).includes(file.bytesBase64), false);
    assert.deepEqual(calls, ["v1-session", "v2-session"].map(sessionId => ({ operation: "act", args: { tabId: "tab", observationId: "obs", action: { type: "attach_files", ref: "e1", files: [file] } }, sessionId })));
  } finally {
    await bridge.close();
    await api.stop();
    for (const [key, value] of Object.entries({ OPENWORK_UI_CONTROL_DISCOVERY: original.discovery, OPENWORK_SERVER_URL: original.url, OPENWORK_SERVER_TOKEN: original.token })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
