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
async function fixture(t, storage) {
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
  auth = createWorkshopAuth({ origin, participants, storage });
  const restart = async (roster = participants, nextStorage = storage) => {
    await auth.close(); auth = createWorkshopAuth({ origin, participants: roster, storage: nextStorage });
    await request("/login");
  };
  t.after(async () => { await auth.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
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
  const authorization = (client, resource = origin + "/outlook/mcp") => {
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
  const redeem = (client, attempt, extra = {}) => form("/oauth/token", { grant_type: "authorization_code", client_id: client.client_id, redirect_uri: client.redirectUri, code: attempt.code, code_verifier: attempt.verifier, resource: attempt.fields.resource, ...extra });
  return { get auth() { return auth; }, origin, request, form, login, register, authorization, issue, redeem, restart };
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
  assert.equal((await (await f.request("/.well-known/oauth-protected-resource/outlook/mcp")).json()).resource, f.origin + "/outlook/mcp");
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
    const attempt = await f.issue(client, session.cookie, f.origin + "/outlook/mcp");
    const response = await f.redeem(client, attempt); assert.equal(response.status, 200);
    const token = await response.json(); assert.equal(token.scope, "workplace"); assert.equal(token.token_type, "Bearer"); assert.equal(typeof token.refresh_token, "string"); assert.equal(token.expires_in, 3600);
    assert.equal((await (await f.request("/outlook/mcp", { headers: { Authorization: `Bearer ${token.access_token}` } })).json()).id, id);
    assert.equal((await f.request("/jira/mcp", { headers: { Authorization: `Bearer ${token.access_token}`, Cookie: bob.cookie } })).status, 401);
    assert.equal((await f.request("/outlook/mcpevil", { headers: { Authorization: `Bearer ${token.access_token}` } })).status, 401);
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
  assert.equal(f.auth.authenticate({ headers: { authorization: `Bearer ${token.access_token}` }, url: "/outlook/mcp" }), null);
  assert.equal(f.auth.authenticate({ headers: { cookie: alice.cookie }, url: "/outlook/mcp" }).id, "alice");
  t.mock.method(Date, "now", () => now + 8 * 60 * 60 * 1000 + 1000);
  assert.equal(f.auth.authenticate({ headers: { cookie: alice.cookie }, url: "/outlook/mcp" }), null);
  assert.equal((await f.form("/oauth/token", { grant_type: "refresh_token", client_id: client.client_id, refresh_token: token.refresh_token })).status, 400);
});

const memoryStorage = () => {
  const data = new Map();
  return { data, read(key) { return structuredClone(data.get(key)); }, write(key, value) { data.set(key, structuredClone(value)); }, delete(key) { data.delete(key); }, close() {} };
};
const refresh = (f, client, token, extra = {}) => f.form("/oauth/token", { grant_type: "refresh_token", client_id: client.client_id, refresh_token: token.refresh_token, resource: f.origin + "/outlook/mcp", ...extra });
const bearer = (token) => ({ headers: { Authorization: `Bearer ${token.access_token}` } });

test("native sign-in, actionable errors, consent denial and sign-in cancellation", async (t) => {
  const f = await fixture(t), client = await f.register(), attempt = f.authorization(client);
  const signIn = await (await f.request("/login?next=" + encodeURIComponent(attempt.path))).text();
  assert.match(signIn, /Acme Workplace/); assert.match(signIn, /Fictional workshop sandbox/);
  assert.match(signIn, /name="token"/); assert.match(signIn, /name="next"/); assert.doesNotMatch(signIn, /type="email"/);
  const invalid = await f.form("/login", { token: "wrong", next: attempt.path });
  assert.equal(invalid.status, 401); assert.match(await invalid.text(), /role="alert"/);
  const cancel = await f.form("/login", { decision: "cancel", next: attempt.path });
  const canceled = new URL(cancel.headers.get("location"));
  assert.equal(canceled.searchParams.get("error"), "access_denied"); assert.equal(canceled.searchParams.get("state"), "opaque-state");
  const alice = await f.login(participants[0]);
  const consent = await (await f.request(attempt.path, { headers: { Cookie: alice.cookie } })).text();
  for (const text of [/Signed in as/, /Unverified workshop application/, /Workplace permissions/, /name="decision" value="deny"/, /No real work accounts/]) assert.match(consent, text);
  const denied = await f.form("/oauth/authorize", { ...attempt.fields, decision: "deny" }, { Cookie: alice.cookie });
  const target = new URL(denied.headers.get("location")); assert.equal(target.searchParams.get("error"), "access_denied"); assert.equal(target.searchParams.has("code"), false);
});

test("refresh rotation preserves client, resource and identity; replay revokes its family only", async (t) => {
  const f = await fixture(t), client = await f.register(), other = await f.register();
  const alice = await f.login(participants[0]), bob = await f.login(participants[1]);
  const token = await (await f.redeem(client, await f.issue(client, alice.cookie))).json();
  const bobToken = await (await f.redeem(client, await f.issue(client, bob.cookie))).json();
  assert.equal((await refresh(f, other, token)).status, 400);
  assert.equal((await refresh(f, client, token, { resource: f.origin + "/other" })).status, 400);
  assert.equal((await refresh(f, client, token, { scope: "admin" })).status, 400);
  const rotatedResponse = await refresh(f, client, token, { resource: f.origin + "/outlook/mcp" });
  assert.equal(rotatedResponse.status, 200); const rotated = await rotatedResponse.json();
  assert.notEqual(rotated.refresh_token, token.refresh_token); assert.equal(rotated.expires_in, 3600);
  assert.equal((await f.request("/outlook/mcp", bearer(rotated))).status, 200);
  assert.equal((await f.request("/other", bearer(rotated))).status, 401);
  assert.equal((await refresh(f, client, token)).status, 400);
  assert.equal((await refresh(f, client, rotated)).status, 400);
  assert.equal((await f.request("/outlook/mcp", bearer(rotated))).status, 401);
  assert.equal((await f.request("/outlook/mcp", bearer(bobToken))).status, 200);
});

test("RFC 7009 revocation checks client and resource, is idempotent, and invalidates access and refresh", async (t) => {
  const f = await fixture(t), client = await f.register(), other = await f.register(), alice = await f.login(participants[0]);
  const metadata = await (await f.request("/.well-known/oauth-authorization-server")).json();
  assert.deepEqual(metadata.grant_types_supported, ["authorization_code", "refresh_token"]); assert.equal(metadata.revocation_endpoint, f.origin + "/oauth/revoke");
  for (const hint of ["access_token", "refresh_token"]) {
    const token = await (await f.redeem(client, await f.issue(client, alice.cookie))).json();
    const revoke = (fields) => f.form("/oauth/revoke", { token: token[hint], token_type_hint: hint, ...fields });
    assert.equal((await revoke({ client_id: other.client_id })).status, 200);
    assert.equal((await revoke({ client_id: client.client_id, resource: f.origin + "/other" })).status, 200);
    assert.equal((await f.request("/outlook/mcp", bearer(token))).status, 200);
    assert.equal((await revoke({ client_id: client.client_id, resource: f.origin + "/outlook/mcp" })).status, 200);
    assert.equal((await revoke({ client_id: client.client_id })).status, 200);
    assert.equal((await f.request("/outlook/mcp", bearer(token))).status, 401);
    assert.equal((await refresh(f, client, token)).status, 400);
  }
  assert.equal((await f.form("/oauth/revoke", { client_id: client.client_id, token: "unknown" })).status, 200);
});

test("storage restores clients, codes, sessions, tokens and refresh replay history without raw secrets", async (t) => {
  const storage = memoryStorage(), f = await fixture(t, storage), client = await f.register(), alice = await f.login(participants[0]);
  const attempt = await f.issue(client, alice.cookie);
  await f.restart();
  assert.equal((await f.request("/who", { headers: { Cookie: alice.cookie } })).status, 200);
  const token = await (await f.redeem(client, attempt)).json();
  const rotated = await (await refresh(f, client, token)).json();
  const saved = JSON.stringify([...storage.data]);
  for (const value of [participants[0].token, participants[1].token, alice.cookie.split("=")[1], attempt.code, token.access_token, token.refresh_token, rotated.refresh_token]) assert.equal(saved.includes(value), false, "Persistent auth must not contain raw credentials");
  assert.equal(saved.includes(participants[0].name), false);
  await f.restart();
  assert.equal((await f.request("/outlook/mcp", bearer(rotated))).status, 200);
  assert.equal((await refresh(f, client, token)).status, 400);
  await f.restart();
  assert.equal((await f.request("/outlook/mcp", bearer(rotated))).status, 401);
  assert.equal((await refresh(f, client, rotated)).status, 400);
});

test("roster removal and changed passwords invalidate restored identities, not other attendees", async (t) => {
  const f = await fixture(t, memoryStorage()), client = await f.register(), alice = await f.login(participants[0]), bob = await f.login(participants[1]);
  const token = await (await f.redeem(client, await f.issue(client, alice.cookie))).json();
  const code = await f.issue(client, alice.cookie);
  await f.restart([{ ...participants[0], token: "changed-workshop-password" }, participants[1]]);
  assert.equal((await f.request("/who", { headers: { Cookie: alice.cookie } })).status, 401);
  assert.equal((await f.request("/who", { headers: { Cookie: bob.cookie } })).status, 200);
  assert.equal((await f.request("/outlook/mcp", bearer(token))).status, 401);
  assert.equal((await refresh(f, client, token)).status, 400);
  assert.equal((await f.redeem(client, code)).status, 400);
  await f.restart([participants[0]]);
  assert.equal((await f.request("/who", { headers: { Cookie: bob.cookie } })).status, 401);
});

test("corrupt snapshots and failed acknowledged writes fail closed", async (t) => {
  const storage = memoryStorage(), f = await fixture(t, storage), alice = await f.login(participants[0]);
  storage.write = () => { throw new Error("disk unavailable"); };
  const failed = await f.form("/login", { token: participants[0].token });
  assert.equal(failed.status, 503); assert.equal(failed.headers.get("set-cookie"), null);
  assert.equal(f.auth.authenticate({ headers: { cookie: alice.cookie }, url: "/who" }), null);
  const corrupt = memoryStorage(); corrupt.data.set("workshop-auth:v1", { version: 1, origin: f.origin, tables: {} });
  await f.restart(participants, corrupt);
  assert.equal((await f.request("/login")).status, 503);
  assert.equal(corrupt.data.get("workshop-auth:v1").tables.sessions, undefined, "Do not overwrite or reseed corrupt storage");
});

test("a full connection quota cannot evict another participant's grant", async (t) => {
  const f = await fixture(t), client = await f.register(), alice = await f.login(participants[0]), bob = await f.login(participants[1]);
  const bobToken = await (await f.redeem(client, await f.issue(client, bob.cookie))).json();
  for (let i = 0; i < 32; i++) assert.equal((await f.redeem(client, await f.issue(client, alice.cookie))).status, 200);
  assert.equal((await f.redeem(client, await f.issue(client, alice.cookie))).status, 429);
  assert.equal((await f.request("/outlook/mcp", bearer(bobToken))).status, 200);
  assert.equal((await refresh(f, client, bobToken)).status, 200);
});

test("OAuth requires one of five exact resources at authorization, exchange and refresh", async (t) => {
  const f = await fixture(t), client = await f.register(), alice = await f.login(participants[0]);
  const badResources = [undefined, f.origin, f.origin + "/", f.origin + "/state", f.origin + "/reset", f.origin + "/outlook/mcp/", f.origin + "/outlook/mcp/child", f.origin + "/outlook/mcp?x=1", f.origin + "/arbitrary", f.origin + "/outlook/mcp#fragment"];
  for (const value of badResources) {
    const attempt = f.authorization(client), fields = { ...attempt.fields };
    if (value === undefined) delete fields.resource; else fields.resource = value;
    assert.equal((await f.request("/oauth/authorize?" + new URLSearchParams(fields), { headers: { Cookie: alice.cookie } })).status, 400);
    const valid = await f.issue(client, alice.cookie);
    const exchange = { grant_type: "authorization_code", client_id: client.client_id, redirect_uri: client.redirectUri, code: valid.code, code_verifier: valid.verifier };
    if (value !== undefined) exchange.resource = value;
    assert.equal((await f.form("/oauth/token", exchange)).status, 400);
  }
  for (const path of ["/outlook/mcp", "/calendar/mcp", "/drive/mcp", "/jira/mcp", "/confluence/mcp"]) {
    const audience = f.origin + path, attempt = await f.issue(client, alice.cookie, audience);
    const response = await f.redeem(client, attempt); assert.equal(response.status, 200);
    const token = await response.json();
    assert.equal((await f.request(path, bearer(token))).status, 200);
    for (const denied of ["/", "/state", "/reset", "/api/state", "/api/reset", path + "/", path + "/child", path === "/jira/mcp" ? "/outlook/mcp" : "/jira/mcp"]) assert.equal((await f.request(denied, bearer(token))).status, 401);
    const fields = { grant_type: "refresh_token", client_id: client.client_id, refresh_token: token.refresh_token };
    assert.equal((await f.form("/oauth/token", fields)).status, 400);
    assert.equal((await f.form("/oauth/token", { ...fields, resource: f.origin })).status, 400);
    assert.equal((await f.form("/oauth/token", { ...fields, resource: f.origin + (path === "/jira/mcp" ? "/outlook/mcp" : "/jira/mcp") })).status, 400);
    assert.equal((await f.form("/oauth/token", { ...fields, resource: audience })).status, 200);
    assert.equal((await f.request("/.well-known/oauth-protected-resource" + path)).status, 200);
  }
  assert.equal((await f.request("/.well-known/oauth-protected-resource")).status, 200);
  for (const path of ["/state", "/reset", "/outlook/mcp/child", "/arbitrary"]) assert.equal((await f.request("/.well-known/oauth-protected-resource" + path)).status, 404);
});

test("refresh extends expired one-hour access but never its original eight-hour grant", async (t) => {
  const f = await fixture(t, memoryStorage()), client = await f.register(), alice = await f.login(participants[0]);
  const token = await (await f.redeem(client, await f.issue(client, alice.cookie))).json(), now = Date.now();
  t.mock.method(Date, "now", () => now + 7.5 * 60 * 60 * 1000);
  await f.restart();
  assert.equal((await f.request("/outlook/mcp", bearer(token))).status, 401);
  const response = await refresh(f, client, token); assert.equal(response.status, 200);
  const rotated = await response.json(); assert.ok(rotated.expires_in <= 1800);
  t.mock.method(Date, "now", () => now + 8 * 60 * 60 * 1000 + 1000);
  assert.equal((await refresh(f, client, rotated)).status, 400);
  assert.equal((await f.request("/outlook/mcp", bearer(rotated))).status, 401);
});

test("malformed persisted credential records cannot authenticate or be silently reseeded", async (t) => {
  const storage = memoryStorage(), f = await fixture(t, storage), client = await f.register(), alice = await f.login(participants[0]);
  await f.redeem(client, await f.issue(client, alice.cookie));
  const baseline = structuredClone(storage.data.get("workshop-auth:v1"));
  const changes = [
    () => null,
    (saved) => { saved.tables.tokens[0][1].resource = f.origin; return saved; },
    (saved) => { saved.tables.tokens[0][1].participant = { id: "forged" }; return saved; },
    (saved) => { saved.tables.sessions[0][1].credentialFingerprint = "malformed"; return saved; },
    (saved) => { saved.tables.refreshes[0][1].used = "false"; return saved; },
    (saved) => { saved.tables.clients[0][1].redirect_uris = ["http://foreign.example/callback"]; return saved; },
  ];
  for (const change of changes) {
    const corrupt = memoryStorage(), saved = change(structuredClone(baseline));
    corrupt.data.set("workshop-auth:v1", saved);
    await f.restart(participants, corrupt);
    assert.equal((await f.request("/login")).status, 503);
    assert.equal(f.auth.authenticate({ headers: { cookie: alice.cookie }, url: "/who" }), null);
    assert.deepEqual(corrupt.data.get("workshop-auth:v1"), saved);
  }
});
