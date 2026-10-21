#!/usr/bin/env node
// Read-only checks of an EXISTING gateway. Never allocates a world or grants OAuth.
import { pathToFileURL } from "node:url";

export const APPS = Object.freeze(["outlook", "calendar", "drive", "jira", "confluence"]);

export function gatewayOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Expected an existing HTTPS gateway origin."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    // Do not echo signed URLs or silently remove authentication carried in path/query.
    throw new Error("Unsupported preview URL: workshop PUBLIC_URL requires an HTTPS origin, not a path/query/bootstrap URL. Obtain a port-bound signed hostname; do not strip its credentials.");
  }
  return url.origin;
}

function requireValue(condition, message) { if (!condition) throw new Error(message); }

/** Run from BOTH the runner and the existing Den sandbox: Den has no browser warning cookie. */
export async function preflight(value, request = fetch) {
  const origin = gatewayOrigin(value);
  const checks = [];
  for (const skip of [false, true]) {
    const mode = skip ? "skip-warning" : "plain";
    const get = async (path, accept = "application/json") => {
      try {
        return await request(origin + path, {
          redirect: "manual", signal: AbortSignal.timeout(15_000),
          headers: { accept, ...(skip ? { "x-daytona-skip-preview-warning": "true" } : {}) },
        });
      } catch {
        throw new Error(`${mode} ${path}: transport failure (check signed preview expiry and Den egress).`);
      }
    };
    const json = async (path) => {
      const response = await get(path);
      requireValue(response.status === 200 && response.headers.get("content-type")?.includes("application/json"), `${mode} ${path}: expected HTTP 200 JSON, got HTTP ${response.status}; possible preview warning/auth redirect.`);
      const body = await response.json().catch(() => null);
      requireValue(body && typeof body === "object" && !Array.isArray(body), `${mode} ${path}: invalid JSON object.`);
      return body;
    };
    const health = await json("/health");
    requireValue(health.ok === true && health.service === "open-workplace-workshop" && health.isolated === true && health.joinMode === "automatic", `${mode}: not a healthy automatic-join workshop.`);
    const issuer = await json("/.well-known/oauth-authorization-server");
    requireValue(issuer.issuer === origin, `${mode}: OAuth issuer differs from exact PUBLIC_URL.`);
    for (const [key, path] of Object.entries({ authorization_endpoint: "/oauth/authorize", token_endpoint: "/oauth/token", registration_endpoint: "/oauth/register", revocation_endpoint: "/oauth/revoke" })) {
      requireValue(issuer[key] === origin + path, `${mode}: unexpected OAuth ${key}.`);
    }
    requireValue(issuer.code_challenge_methods_supported?.includes("S256") && issuer.token_endpoint_auth_methods_supported?.includes("none"), `${mode}: expected public S256 PKCE client.`);
    for (const app of APPS) {
      const metadataPath = `/.well-known/oauth-protected-resource/${app}/mcp`;
      const metadata = await json(metadataPath);
      requireValue(metadata.resource === `${origin}/${app}/mcp` && JSON.stringify(metadata.authorization_servers) === JSON.stringify([origin]), `${mode} ${app}: OAuth resource/issuer mismatch.`);
      const challenge = await get(`/${app}/mcp`);
      requireValue(challenge.status === 401 && challenge.headers.get("www-authenticate")?.includes(`resource_metadata="${origin}${metadataPath}"`), `${mode} ${app}: expected unauthenticated 401 with exact resource metadata challenge.`);
      // A real top-level navigation must see a login redirect, not a 200 preview warning.
      const navigation = await get(`/${app}/mcp`, "text/html");
      requireValue(navigation.status === 303 && navigation.headers.get("location") === `/login?next=${encodeURIComponent(`/${app}/mcp`)}`, `${mode} ${app}: browser entry is not the workshop login redirect (possible preview warning).`);
      checks.push(`${mode}:${app}`);
    }
  }
  return { ok: true, checks, note: "Read-only discovery only: browser consent, Den token exchange and isolation/reset remain unverified." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // Use environment, not argv, so a mistakenly supplied signed query is not printed.
    console.log(JSON.stringify(await preflight(process.env.WORKSHOP_PILOT_URL)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Preflight failed.");
    process.exitCode = 1;
  }
}
