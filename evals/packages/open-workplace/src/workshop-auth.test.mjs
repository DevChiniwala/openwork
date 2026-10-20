// Standalone Node 22+ integration proof; no product dependencies or external identity provider.
// node --test evals/packages/open-workplace/src/workshop-auth.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { createWorkshopAuth } from "./workshop-auth.mjs";

const participants = [
  { id: "alice", name: "Alice <Workshop>", token: "alice-" + "a".repeat(40) },
  { id: "bob", name: "Bob Workshop", token: "bob-" + "b".repeat(40) },
];
async function fixture(t) {
  let auth;
  const server = createServer(async (req, res) => {
    if (await auth.handle(req, res, new URL(req.url, origin))) return;
    if (!auth.requireMutationOrigin(req)) { res.writeHead(403); res.end(); return; }
    const participant = auth.authenticate(req);
    res.writeHead(participant ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify(participant ? { id: participant.id, name: participant.name } : null));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  auth = createWorkshopAuth({ origin, participants });
  t.after(async () => { auth.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const request = (path, options = {}) => fetch(origin + path, { redirect: "manual", ...options });
  const form = (path, fields, headers = {}) => request(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin, ...headers }, body: new URLSearchParams(fields) });
  const login = async (participant, next = "/", headers = {}) => {
    const response = await form("/login", { token: participant.token, next }, headers);
    assert.equal(response.status, 303);
    return { response, cookie: response.headers.get("set-cookie").split(";")[0] };
  };
  const register = async (redirectUri = "http://127.0.0.1:54321/callback", extra = {}) => {
    const response = await request("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Test <client>", ...extra }) });
    assert.equal(response.status, 201); return { ...await response.json(), redirectUri };
  };
  const authorization = (client, resource = origin + "/mcp") => {
    const verifier = randomBytes(32).toString("base64url");
    const fields = { client_id: client.client_id, redirect_uri: client.redirectUri, response_type: "code", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), scope: "workplace", state: "opaque-state", resource };
    return { verifier, fields, path: "/oauth/authorize?" + new URLSearchParams(fields) };
  };
  const issue = async (client, cookie, resource) => {
    const attempt = authorization(client, resource);
    const consent = await request(attempt.path, { headers: { Cookie: cookie } });
    assert.equal(consent.status, 200); assert.equal(consent.headers.get("location"), null);
    const html = await consent.text(); assert.match(html, /Allow workplace access/); assert.match(html, /Test &lt;client&gt;/);
    const response = await form("/oauth/authorize", attempt.fields, { Cookie: cookie });
    assert.equal(response.status, 303);
    const target = new URL(response.headers.get("location")); assert.equal(target.searchParams.get("state"), "opaque-state");
    return { ...attempt, code: target.searchParams.get("code") };
  };
  const redeem = (client, attempt, extra = {}) => form("/oauth/token", { grant_type: "authorization_code", client_id: client.client_id, redirect_uri: client.redirectUri, code: attempt.code, code_verifier: attempt.verifier, ...extra });
  return { auth, origin, request, form, login, register, authorization, issue, redeem };
}

test("two browser identities, session rotation, logout, bearer precedence, and escaped persona", async (t) => {
  const f = await fixture(t);
  const alice = await f.login(participants[0], "/jira"), bob = await f.login(participants[1]);
  assert.notEqual(alice.cookie, bob.cookie);
  assert.equal(alice.response.headers.get("location"), "/jira");
  assert.match(alice.response.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Max-Age=28800/);
  for (const [session, participant] of [[alice, participants[0]], [bob, participants[1]]]) {
    assert.deepEqual(await (await f.request("/who", { headers: { Cookie: session.cookie } })).json(), { id: participant.id, name: participant.name });
  }
  assert.equal((await f.request("/who", { headers: { Cookie: alice.cookie, Authorization: "Bearer invalid" } })).status, 401);
  assert.equal((await f.request("/who", { headers: { Cookie: alice.cookie, Authorization: "Basic invalid" } })).status, 401);
  assert.equal((await (await f.request("/who", { headers: { Cookie: alice.cookie, Authorization: `Bearer ${participants[1].token}` } })).json()).id, "bob");
  const html = await (await f.request("/login", { headers: { Cookie: alice.cookie } })).text();
  assert.match(html, /Alice &lt;Workshop&gt;/); assert.doesNotMatch(html, /Alice <Workshop>/); assert.doesNotMatch(html, new RegExp(participants[0].token));
  const rotated = await f.login(participants[0], "/", { Cookie: alice.cookie });
  assert.notEqual(rotated.cookie, alice.cookie);
  assert.equal((await f.request("/who", { headers: { Cookie: alice.cookie } })).status, 401);
  assert.equal((await f.form("/logout", {}, { Cookie: rotated.cookie })).status, 303);
  assert.equal((await f.request("/who", { headers: { Cookie: rotated.cookie } })).status, 401);
  assert.equal((await f.request("/who", { headers: { Cookie: bob.cookie } })).status, 200);
});

test("same-origin policy rejects foreign Origin even with bearer and on GET; cookie writes require origin", async (t) => {
  const f = await fixture(t), alice = await f.login(participants[0]);
  assert.equal((await f.request("/who", { headers: { Cookie: alice.cookie, Origin: "https://foreign.example" } })).status, 403);
  assert.equal((await f.request("/who", { headers: { Authorization: `Bearer ${participants[0].token}`, Origin: "https://foreign.example" } })).status, 403);
  assert.equal((await f.request("/write", { method: "POST", headers: { Cookie: alice.cookie } })).status, 403);
  assert.equal((await f.request("/write", { method: "POST", headers: { Cookie: alice.cookie, Referer: f.origin + "/jira" } })).status, 200);
  assert.equal((await f.request("/write", { method: "POST", headers: { Authorization: `Bearer ${participants[0].token}` } })).status, 200);
  assert.equal((await f.form("/login", { token: participants[0].token }, { Origin: "https://foreign.example" })).status, 403);
  assert.equal((await f.form("/logout", {}, { Cookie: alice.cookie, Origin: "https://foreign.example" })).status, 403);
  assert.equal((await f.request("/logout", { method: "POST", headers: { Cookie: alice.cookie } })).status, 403);
});

test("login rejects URL tokens and unsafe next destinations; body bounded and failures throttled", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/login?token=never-use-query-tokens")).status, 400);
  for (const next of ["https://foreign.example", "//foreign.example", "/\\foreign.example", "/%2fforeign.example", "/%5cforeign.example", "/\nLocation:bad"]) {
    assert.equal((await f.login(participants[0], next)).response.headers.get("location"), "/");
  }
  assert.equal((await f.form("/login", { token: "x".repeat(17000) })).status, 413);
  const oversized = await f.request("/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: f.origin }, duplex: "half", body: (async function* () { yield "token="; yield "x".repeat(17000); })() });
  assert.equal(oversized.status, 413);
  for (let i = 0; i < 20; i++) assert.equal((await f.form("/login", { token: "wrong" })).status, 401);
  assert.equal((await f.form("/login", { token: "wrong" })).status, 429);
  assert.equal((await f.login(participants[1])).response.status, 303, "A shared venue IP's failed guesses must not block valid attendees");
});

test("OAuth discovery, DCR restrictions and credentialless CORS", async (t) => {
  const f = await fixture(t);
  const metadataResponse = await f.request("/.well-known/oauth-authorization-server"), metadata = await metadataResponse.json();
  assert.equal(metadata.issuer, f.origin); assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.equal(metadataResponse.headers.get("cache-control"), "no-store");
  assert.equal((await (await f.request("/.well-known/oauth-protected-resource/mcp/microsoft365")).json()).resource, f.origin + "/mcp/microsoft365");
  for (const redirect of ["http://foreign.example/cb", "https://user:password@example.com/cb", "https://example.com/cb#fragment", "https://example.com/cb#", "javascript:alert(1)"]) {
    const response = await f.request("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect] }) });
    assert.equal(response.status, 400);
  }
  await f.register("https://client.example/callback");
  const preflight = await f.request("/oauth/token", { method: "OPTIONS", headers: { Origin: "https://client.example" } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get("access-control-allow-origin"), "*"); assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
});

test("OAuth requires browser login and explicit same-origin consent before issuing a code", async (t) => {
  const f = await fixture(t), client = await f.register(), attempt = f.authorization(client);
  const anonymous = await f.request(attempt.path);
  assert.equal(anonymous.status, 303);
  const next = new URL(anonymous.headers.get("location"), f.origin).searchParams.get("next"); assert.equal(next, attempt.path);
  const alice = await f.login(participants[0], next);
  const page = await f.request(attempt.path, { headers: { Cookie: alice.cookie } });
  assert.equal(page.status, 200); assert.equal(page.headers.get("location"), null);
  const html = await page.text(); assert.match(html, /Alice &lt;Workshop&gt;/); assert.match(html, /127.0.0.1:54321/);
  assert.equal((await f.form("/oauth/authorize", attempt.fields, { Cookie: alice.cookie, Origin: "https://foreign.example" })).status, 403);
  assert.equal((await f.request(attempt.path, { headers: { Cookie: alice.cookie, Origin: "https://foreign.example" } })).status, 403);
  assert.equal((await f.request("/oauth/authorize", { method: "POST", headers: { Cookie: alice.cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(attempt.fields) })).status, 403);
});

test("OAuth PKCE tokens retain participant isolation, reject replay and enforce resource path", async (t) => {
  const f = await fixture(t), client = await f.register();
  const alice = await f.login(participants[0]), bob = await f.login(participants[1]);
  for (const [session, id] of [[alice, "alice"], [bob, "bob"]]) {
    const attempt = await f.issue(client, session.cookie, f.origin + "/mcp/microsoft365");
    const response = await f.redeem(client, attempt); assert.equal(response.status, 200);
    const token = await response.json(); assert.equal(token.scope, "workplace"); assert.equal(token.token_type, "Bearer"); assert.equal(token.refresh_token, undefined);
    assert.equal((await (await f.request("/mcp/microsoft365", { headers: { Authorization: `Bearer ${token.access_token}` } })).json()).id, id);
    assert.equal((await f.request("/mcp/atlassian", { headers: { Authorization: `Bearer ${token.access_token}`, Cookie: bob.cookie } })).status, 401);
    assert.equal((await f.request("/mcp/microsoft365evil", { headers: { Authorization: `Bearer ${token.access_token}` } })).status, 401);
    assert.equal((await f.redeem(client, attempt)).status, 400);
  }
});

test("OAuth rejects wrong verifier, client, redirect, audience, scope and non-S256 requests", async (t) => {
  const f = await fixture(t), client = await f.register(), other = await f.register(), alice = await f.login(participants[0]);
  for (const extra of [{ code_verifier: "z".repeat(43) }, { client_id: other.client_id }, { redirect_uri: "http://127.0.0.1:54321/other" }, { resource: "https://foreign.example/mcp" }, { resource: f.origin + "/mcp/other" }, { scope: "admin" }]) {
    const attempt = await f.issue(client, alice.cookie);
    assert.equal((await f.redeem(client, attempt, extra)).status, 400);
    assert.equal((await f.redeem(client, attempt)).status, 400, "failed redemption consumes the code");
  }
  for (const extra of [{ code_challenge_method: "plain" }, { scope: "admin" }, { redirect_uri: "https://foreign.example/callback" }, { resource: "https://foreign.example/mcp" }]) {
    const attempt = f.authorization(client);
    const response = await f.request("/oauth/authorize?" + new URLSearchParams({ ...attempt.fields, ...extra }), { headers: { Cookie: alice.cookie } });
    assert.equal(response.status, 400); assert.equal(response.headers.get("location"), null);
  }
});

test("DCR registrations are rate bounded", async (t) => {
  const f = await fixture(t);
  // A cohort can register all five connectors behind one venue/proxy IP.
  for (let i = 0; i < 600; i++) await f.register();
  const response = await f.request("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://localhost/callback"] }) });
  assert.equal(response.status, 429);
});

test("one participant cannot evict another's browser sessions or consume their authorization quota", async (t) => {
  const f = await fixture(t), alice = await f.login(participants[0]), bob = await f.login(participants[1]);
  let latestAlice = alice;
  for (let i = 0; i < 29; i++) latestAlice = await f.login(participants[0]);
  assert.equal((await f.form("/login", { token: participants[0].token })).status, 429);
  assert.equal((await f.request("/who", { headers: { Cookie: alice.cookie } })).status, 401, "Only Alice's old sessions may be reclaimed");
  assert.equal((await f.request("/who", { headers: { Cookie: bob.cookie } })).status, 200);
  const client = await f.register();
  const current = await f.login(participants[1]);
  for (let i = 0; i < 16; i++) await f.issue(client, current.cookie);
  const rejected = f.authorization(client);
  assert.equal((await f.form("/oauth/authorize", rejected.fields, { Cookie: current.cookie })).status, 429);
  assert.ok((await f.issue(client, latestAlice.cookie)).code, "Bob's quota must not block Alice's authorization");
});

test("authorization codes, access tokens and browser sessions expire", async (t) => {
  const f = await fixture(t), client = await f.register(), alice = await f.login(participants[0]);
  const code = await f.issue(client, alice.cookie);
  const secondCode = await f.issue(client, alice.cookie);
  const token = await (await f.redeem(client, secondCode)).json();
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 5 * 60 * 1000 + 1000);
  assert.equal((await f.redeem(client, code)).status, 400);
  t.mock.method(Date, "now", () => now + 60 * 60 * 1000 + 1000);
  assert.equal(f.auth.authenticate({ headers: { authorization: `Bearer ${token.access_token}` }, url: "/mcp" }), null);
  assert.equal(f.auth.authenticate({ headers: { cookie: alice.cookie }, url: "/mcp" }).id, "alice");
  t.mock.method(Date, "now", () => now + 8 * 60 * 60 * 1000 + 1000);
  assert.equal(f.auth.authenticate({ headers: { cookie: alice.cookie }, url: "/mcp" }), null);
});
