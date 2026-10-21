// Pure mocked contract tests; no listeners, application launch, credentials or infrastructure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPS, gatewayOrigin, preflight } from "../../worlds/lib/workshop-pilot-oauth.mjs";
import { browserProbe } from "../../worlds/lib/workshop-pilot-oauth-browser.mjs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";

const origin = "https://3994-signed.proxy.example.test";
function fixture(alter = () => undefined) {
  const requests = [];
  return { requests, request: async (input, options) => {
    requests.push({ input, options });
    const path = new URL(input).pathname;
    let body, status = 200, headers = { "content-type": "application/json" };
    if (path === "/health") body = { ok: true, service: "open-workplace-workshop", isolated: true, joinMode: "automatic" };
    else if (path === "/.well-known/oauth-authorization-server") body = {
      issuer: origin, authorization_endpoint: origin + "/oauth/authorize", token_endpoint: origin + "/oauth/token", registration_endpoint: origin + "/oauth/register", revocation_endpoint: origin + "/oauth/revoke", code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
    };
    else if (path.startsWith("/.well-known/oauth-protected-resource/")) body = { resource: origin + path.slice("/.well-known/oauth-protected-resource".length), authorization_servers: [origin] };
    else {
      assert.ok(APPS.some((app) => path === `/${app}/mcp`));
      if (options.headers.accept === "text/html") { status = 303; headers.location = `/login?next=${encodeURIComponent(path)}`; }
      else { status = 401; headers["www-authenticate"] = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${path}"`; }
      body = { error: "authentication_required" };
    }
    const changed = alter({ path, options, body, status, headers }) ?? {};
    return new Response(JSON.stringify(changed.body ?? body), { status: changed.status ?? status, headers: changed.headers ?? headers });
  } };
}

test("rejects non-origin previews without printing their embedded secret", () => {
  assert.equal(gatewayOrigin(origin + "/"), origin);
  for (const value of [origin + "/bootstrap/hidden-value", origin + "/?token=hidden-value", origin + "#hidden-value", "http://127.0.0.1:3994", "https://user:hidden-value@example.test"]) {
    assert.throws(() => gatewayOrigin(value), (error) => !error.message.includes("hidden-value") && /Unsupported preview/.test(error.message));
  }
});

test("checks all five resources and browser entries both with and without warning bypass", async () => {
  const f = fixture();
  const receipt = await preflight(origin, f.request);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.checks.length, 10);
  assert.equal(f.requests.length, 34);
  assert.ok(f.requests.every(({ options }) => options.redirect === "manual" && !options.method && !options.headers.authorization && !options.headers.cookie));
});

test("plain clients blocked by warning fail even when bypass requests would pass", async () => {
  const f = fixture(({ options }) => !options.headers["x-daytona-skip-preview-warning"] ? { headers: { "content-type": "text/html" }, body: "preview warning" } : undefined);
  await assert.rejects(preflight(origin, f.request), /plain \/health.*preview warning/);
});

test("rejects per-app resource and issuer mismatch", async () => {
  for (const bad of [{ resource: origin + "/drive/mcp", authorization_servers: [origin] }, { resource: origin + "/confluence/mcp", authorization_servers: ["https://other.example.test"] }]) {
    const f = fixture(({ path }) => path.endsWith("/confluence/mcp") && path.startsWith("/.well-known/") ? { body: bad } : undefined);
    await assert.rejects(preflight(origin, f.request), /confluence: OAuth resource\/issuer mismatch/);
  }
});

test("a 200 HTML browser warning cannot masquerade as a working navigation", async () => {
  const f = fixture(({ path, options }) => path === "/jira/mcp" && options.headers.accept === "text/html" ? { status: 200, headers: { "content-type": "text/html" } } : undefined);
  await assert.rejects(preflight(origin, f.request), /jira: browser entry/);
});

test("transport errors never leak provider response or signed URL", async () => {
  await assert.rejects(preflight(origin, async () => { throw new Error("hidden-value"); }), (error) => /transport failure/.test(error.message) && !error.message.includes("hidden-value"));
});

test("browser helper is serializable and validates operations before accessing browser state", async () => {
  await assert.rejects(browserProbe("reset"), /Invalid pilot operation/);
  await assert.rejects(browserProbe("mark", "not-a-safe-marker"), /Invalid pilot operation/);
  assert.doesNotThrow(() => new Function(`return (${browserProbe.toString()})`));
});

function browserFixture() {
  const requests = [];
  const context = {
    location: { protocol: "https:" }, crypto: webcrypto, TextEncoder,
    fetch: async (path, options = {}) => {
      requests.push({ path, options });
      assert.ok(path.startsWith("/") && !path.startsWith("//"));
      assert.equal(options.headers?.authorization, undefined);
      let body = {};
      if (path === "/health") body = { service: "open-workplace-workshop", joinMode: "automatic" };
      else if (path === "/v1.0/me") body = { displayName: "Workshop guest 1", mail: "fictional@acme.test" };
      else if (path === "/_workshop/state/microsoft") body = { messages: [], files: [] };
      else if (path === "/_workshop/state/atlassian") body = { jira: { issues: { issue1: { key: "DEMO-1" } } } };
      else if (path.startsWith("/confluence/rest/api/content?")) body = { results: [{ id: "page1", version: { number: 1 } }] };
      else if (path === "/v1.0/me/drive/root/children") body = { value: [{ name: "workshop-pilot-private.txt" }] };
      else if (path.includes(":/content")) body = { id: "private-file-id" };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    },
  };
  const call = (action) => runInNewContext(`(${browserProbe.toString()})(${JSON.stringify(action)})`, context);
  return { requests, call };
}

test("serialized browser snapshot hashes both state services without exposing their contents", async () => {
  const f = browserFixture();
  const first = await f.call("snapshot"), second = await f.call("snapshot");
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.match(first.hashes.microsoft, /^[a-f0-9]{64}$/);
  assert.match(first.hashes.atlassian, /^[a-f0-9]{64}$/);
  assert.equal((await f.call("find")).markerPresent, true);
  assert.ok(f.requests.every(({ options }) => !options.method || options.method === "GET"));
});

test("serialized marker writes all five services but never approves OAuth or resets", async () => {
  const f = browserFixture();
  const result = await f.call("mark");
  assert.equal(result.fileId, "private-file-id");
  assert.equal(JSON.stringify(result.changed), JSON.stringify(APPS));
  const writes = f.requests.filter(({ options }) => options.method && options.method !== "GET");
  assert.equal(writes.length, 5);
  assert.ok(writes.every(({ path }) => !path.includes("oauth") && !path.includes("reset")));
  assert.ok(writes.some(({ path }) => path === "/jira/rest/api/2/issue/DEMO-1"));
  assert.ok(writes.some(({ path }) => path === "/confluence/rest/api/content/page1"));
});
