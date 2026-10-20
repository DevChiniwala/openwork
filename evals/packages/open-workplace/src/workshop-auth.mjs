// Standalone fictional workshop authentication. Node builtins only; no upstream identity provider.
// OAuth public clients use authorization_code + S256 PKCE, scope workplace, and no refresh tokens.
import { createHash, randomBytes } from "node:crypto";
import { workshopPage as page, escapeHtml } from "./workshop-html.mjs";

const SESSION_MS = 8 * 60 * 60 * 1000;
const TOKEN_MS = 60 * 60 * 1000;
const CODE_MS = 5 * 60 * 1000;
const LIMIT = 2048;
const secret = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("base64url");
const safeNext = (value) => {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x20\x7f]/.test(value)) return "/";
  // Reject encoded slashes/backslashes too: downstream routers may decode before redirecting.
  try { if (/^[\/\\]{2}|\\|[\x00-\x1f\x7f]/.test(decodeURIComponent(value))) return "/"; } catch { return "/"; }
  return value;
};

export function createWorkshopAuth({ origin, participants }) {
  const base = new URL(origin);
  if (base.origin !== origin || !["http:", "https:"].includes(base.protocol)) throw new Error("Workshop origin must be an HTTP(S) origin");
  const identities = new Map(participants.map((participant) => [digest(participant.token), participant]));
  const sessions = new Map(), clients = new Map(), codes = new Map(), tokens = new Map(), rates = new Map();
  const cookieName = base.protocol === "https:" ? "__Host-workshop_session" : "workshop_session";
  const prune = (map) => { for (const [key, entry] of map) if (entry.expires <= Date.now()) map.delete(key); };
  function budget(req, category, maximum, failureOnly = false) {
    prune(rates);
    // Many attendees share one venue/proxy IP; authenticated approvals budget per participant.
    const identity = category === "authorize" ? browserParticipant(req)?.id : null;
    const key = `${category}:${identity ? `participant:${identity}` : req.socket?.remoteAddress || "unknown"}`;
    let entry = rates.get(key);
    if (!entry) {
      if (rates.size >= LIMIT) return false;
      entry = { count: 0, expires: Date.now() + 60000 }; rates.set(key, entry);
    }
    if (entry.count >= maximum) return false;
    if (!failureOnly) entry.count++;
    return true;
  }
  function failure(req, category) { budget(req, category, Number.MAX_SAFE_INTEGER); }
  function cookieKey(req) {
    const match = String(req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(cookieName + "="));
    return match ? digest(match.slice(cookieName.length + 1)) : null;
  }
  function browserParticipant(req) {
    prune(sessions);
    return sessions.get(cookieKey(req))?.participant || null;
  }
  function resource(value) {
    try {
      const parsed = new URL(value);
      return parsed.origin === origin && !parsed.username && !parsed.password && !parsed.hash && !parsed.search ? parsed.href : null;
    } catch { return null; }
  }
  function authenticate(req) {
    if (req.headers.authorization !== undefined) {
      const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(req.headers.authorization);
      if (!match) return null;
      const hash = digest(match[1]);
      if (identities.has(hash)) return identities.get(hash);
      prune(tokens);
      const token = tokens.get(hash);
      if (!token) return null;
      if (token.resource) {
        const path = new URL(req.url, origin).pathname;
        const audiencePath = new URL(token.resource).pathname.replace(/\/$/, "");
        if (audiencePath && path !== audiencePath && !path.startsWith(audiencePath + "/")) return null;
      }
      return token.participant;
    }
    return browserParticipant(req);
  }
  function requireMutationOrigin(req) {
    if (req.headers.origin !== undefined && req.headers.origin !== origin) return false;
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
    if (req.headers.authorization !== undefined) return !!authenticate(req);
    return browserOrigin(req);
  }
  function browserOrigin(req) {
    if (req.headers.origin !== undefined) return req.headers.origin === origin;
    try { return new URL(req.headers.referer).origin === origin; } catch { return false; }
  }
  function send(res, status, body, type = "application/json") {
    // Chromium sends Origin: null for native form POSTs from no-referrer pages.
    // same-origin preserves CSRF validation without leaking referrers to OAuth callbacks.
    res.writeHead(status, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "Content-Security-Policy": res.getHeader("Content-Security-Policy") || "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  }
  const error = (res, status, name) => send(res, status, { error: name });
  function redirect(res, location) {
    res.writeHead(303, { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "same-origin" }); res.end();
  }
  function setCookie(res, value, age) {
    res.setHeader("Set-Cookie", `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${base.protocol === "https:" ? "; Secure" : ""}`);
  }
  async function body(req, json = false) {
    const expected = json ? "application/json" : "application/x-www-form-urlencoded";
    if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== expected) throw { status: 415 };
    if (Number(req.headers["content-length"]) > 16384) { req.resume(); throw { status: 413 }; }
    let size = 0; const chunks = [];
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 16384) { req.resume(); throw { status: 413 }; }
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (json) { try { return JSON.parse(text); } catch { throw { status: 400 }; } }
    const result = new URLSearchParams(text);
    if ([...new Set(result.keys())].some((key) => result.getAll(key).length !== 1)) throw { status: 400 };
    return result;
  }
  const redirectAllowed = (value) => {
    try {
      const target = new URL(value);
      return !value.includes("#") && !target.origin.includes("'") && !target.username && !target.password && (target.protocol === "https:" || (target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)));
    } catch { return false; }
  };
  function loginPage(res, next, participant = null) {
    // Native form controls intentionally keep this standalone fixture free of UI dependencies (DESIGN P5).
    send(res, 200, page("Sign in to the workshop", `<p class="muted">Private sandbox · Fictional sample data</p>${participant ? `<p>Signed in as ${escapeHtml(participant.name)}</p>` : ""}<form action="/login" method="post"><input type="hidden" name="next" value="${escapeHtml(next)}"><p><label for="token">Workshop access code</label><input id="token" name="token" type="password" autocomplete="off" required></p><button type="submit">Sign in</button></form>`), "text/html");
  }
  async function handle(req, res, url) {
    const path = url.pathname;
    const metadata = path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-protected-resource" || path.startsWith("/.well-known/oauth-protected-resource/");
    const clientEndpoint = path === "/oauth/register" || path === "/oauth/token";
    if (!["/login", "/logout", "/oauth/authorize"].includes(path) && !metadata && !clientEndpoint) return false;
    res.setHeader("Cache-Control", "no-store");
    if (metadata || clientEndpoint) {
      // Credentialless public OAuth clients may run on another origin. Cookies are never used here.
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return true; }
    }
    try {
      if (metadata && req.method === "GET") {
        if (path === "/.well-known/oauth-authorization-server") send(res, 200, { issuer: origin, authorization_endpoint: origin + "/oauth/authorize", token_endpoint: origin + "/oauth/token", registration_endpoint: origin + "/oauth/register", response_types_supported: ["code"], grant_types_supported: ["authorization_code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["workplace"] });
        else send(res, 200, { resource: origin + path.slice("/.well-known/oauth-protected-resource".length), authorization_servers: [origin], scopes_supported: ["workplace"], bearer_methods_supported: ["header"] });
      } else if (path === "/login" && req.method === "GET") {
        if (url.searchParams.has("token")) error(res, 400, "Access codes must be sent by POST");
        else loginPage(res, safeNext(url.searchParams.get("next")), browserParticipant(req));
      } else if ((path === "/login" || path === "/logout") && req.method === "POST") {
        if (!browserOrigin(req)) { error(res, 403, "Same-origin request required"); return true; }
        if (path === "/logout") { sessions.delete(cookieKey(req)); setCookie(res, "", 0); redirect(res, "/login"); return true; }
        const form = await body(req);
        const participant = identities.get(digest(form.get("token") || ""));
        if (!participant) {
          if (!budget(req, "login", 20, true)) { error(res, 429, "too_many_requests"); return true; }
          failure(req, "login"); error(res, 401, "Invalid access code. Try your workshop access code."); return true;
        }
        if (!budget(req, `session:${participant.id}`, 30)) { error(res, 429, "too_many_requests"); return true; }
        prune(sessions); sessions.delete(cookieKey(req));
        const ownSessions = [...sessions].filter(([, entry]) => entry.participant.id === participant.id);
        if (ownSessions.length >= 8) sessions.delete(ownSessions[0][0]);
        if (sessions.size >= LIMIT) { error(res, 503, "temporarily_unavailable"); return true; }
        const session = secret(); sessions.set(digest(session), { participant, expires: Date.now() + SESSION_MS });
        setCookie(res, session, SESSION_MS / 1000); redirect(res, safeNext(form.get("next")));
      } else if (path === "/oauth/register" && req.method === "POST") {
        if (!budget(req, "register", 600)) { error(res, 429, "too_many_requests"); return true; }
        const data = await body(req, true);
        if (!data || !Array.isArray(data.redirect_uris) || !data.redirect_uris.length || data.redirect_uris.length > 10 || !data.redirect_uris.every((uri) => typeof uri === "string" && uri.length <= 2048 && redirectAllowed(uri)) || (data.token_endpoint_auth_method !== undefined && data.token_endpoint_auth_method !== "none") || (data.grant_types !== undefined && (!Array.isArray(data.grant_types) || data.grant_types.length !== 1 || data.grant_types[0] !== "authorization_code")) || (data.response_types !== undefined && (!Array.isArray(data.response_types) || data.response_types.length !== 1 || data.response_types[0] !== "code")) || (data.scope !== undefined && data.scope !== "workplace")) { error(res, 400, "invalid_client_metadata"); return true; }
        prune(clients);
        if (clients.size >= 1024) { error(res, 503, "temporarily_unavailable"); return true; }
        const client = { client_id: secret(), client_name: typeof data.client_name === "string" ? data.client_name.slice(0, 120) : "Workshop MCP client", redirect_uris: [...new Set(data.redirect_uris)], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"], scope: "workplace" };
        clients.set(client.client_id, { ...client, expires: Date.now() + SESSION_MS }); send(res, 201, client);
      } else if (path === "/oauth/authorize" && ["GET", "POST"].includes(req.method)) {
        if (!requireMutationOrigin(req) || (req.method === "POST" && !browserOrigin(req))) { error(res, 403, "Same-origin request required"); return true; }
        if (!budget(req, "authorize", browserParticipant(req) ? 120 : 600)) { error(res, 429, "too_many_requests"); return true; }
        const query = req.method === "POST" ? await body(req) : url.searchParams;
        if ([...new Set(query.keys())].some((key) => query.getAll(key).length !== 1)) { error(res, 400, "invalid_request"); return true; }
        prune(clients); const client = clients.get(query.get("client_id"));
        const redirectUri = query.get("redirect_uri");
        if (!client || !client.redirect_uris.includes(redirectUri)) { error(res, 400, "invalid_request"); return true; }
        if (query.get("response_type") !== "code" || query.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(query.get("code_challenge") || "") || (query.has("scope") && query.get("scope") !== "workplace") || (query.has("resource") && !resource(query.get("resource")))) { error(res, 400, "invalid_request"); return true; }
        const participant = browserParticipant(req);
        if (!participant) { redirect(res, "/login?next=" + encodeURIComponent(safeNext("/oauth/authorize?" + query.toString()))); return true; }
        if (req.method === "GET") {
          const fields = [...query].map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join("");
          // Chromium checks the final redirect of a form POST against form-action too.
          // Only this client's already-validated callback origin is added to the consent form.
          res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`);
          send(res, 200, page(`Connect ${client.client_name}`, `<p class="muted">Private sandbox · Fictional sample data</p><p>Allow ${escapeHtml(new URL(redirectUri).host)} to access workplace data as ${escapeHtml(participant.name)}?</p><form action="/oauth/authorize" method="post">${fields}<button type="submit">Allow workplace access</button></form><p><a href="/">Cancel</a></p>`), "text/html"); return true;
        }
        prune(codes);
        if ([...codes.values()].filter((entry) => entry.participant.id === participant.id).length >= 16) { error(res, 429, "authorization_quota_reached"); return true; }
        if (codes.size >= LIMIT) { error(res, 503, "temporarily_unavailable"); return true; }
        const code = secret(); codes.set(digest(code), { participant, clientId: client.client_id, redirectUri, challenge: query.get("code_challenge"), resource: query.has("resource") ? resource(query.get("resource")) : null, expires: Date.now() + CODE_MS });
        const target = new URL(redirectUri); target.searchParams.set("code", code);
        if (query.has("state")) target.searchParams.set("state", query.get("state"));
        redirect(res, target.href);
      } else if (path === "/oauth/token" && req.method === "POST") {
        const form = await body(req);
        prune(codes); prune(clients); prune(tokens);
        const codeKey = digest(form.get("code") || ""), code = codes.get(codeKey);
        // A failed redemption also consumes the code, preventing verifier guessing and retries.
        codes.delete(codeKey);
        const verifier = form.get("code_verifier") || "";
        if (form.get("grant_type") !== "authorization_code" || !code || !clients.has(form.get("client_id")) || code.clientId !== form.get("client_id") || code.redirectUri !== form.get("redirect_uri") || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || digest(verifier) !== code.challenge || (form.has("resource") && (!resource(form.get("resource")) || (code.resource && resource(form.get("resource")) !== code.resource))) || (form.has("scope") && form.get("scope") !== "workplace")) {
          if (!budget(req, "token", 20, true)) { error(res, 429, "too_many_requests"); return true; }
          failure(req, "token"); error(res, 400, "invalid_grant"); return true;
        }
        const ownTokens = [...tokens].filter(([, entry]) => entry.participant.id === code.participant.id);
        if (ownTokens.length >= 32) tokens.delete(ownTokens[0][0]);
        if (tokens.size >= LIMIT * 2) { error(res, 503, "temporarily_unavailable"); return true; }
        const token = secret(); tokens.set(digest(token), { participant: code.participant, resource: code.resource || (form.has("resource") ? resource(form.get("resource")) : null), expires: Date.now() + TOKEN_MS });
        send(res, 200, { access_token: token, token_type: "Bearer", expires_in: TOKEN_MS / 1000, scope: "workplace" });
      } else error(res, 405, "method_not_allowed");
    } catch (caught) { error(res, caught.status || 400, "invalid_request"); }
    return true;
  }
  return { authenticate, handle, requireMutationOrigin, close() { sessions.clear(); clients.clear(); codes.clear(); tokens.clear(); rates.clear(); } };
}
