import { ApiError } from "./errors.js";
import { writeLocalProviderAuth, type LocalProviderCatalog } from "./opencode-v2-local-auth.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Provider routes the app's engine client sends under `/opencode2` that
 * OpenCode v2 does not serve. OpenWork answers them itself:
 *
 * - `PUT|POST /auth/:id` and `DELETE /auth/:id` save or remove an API key
 *   added on this computer (OpenCode v2 receives it through the provider mirror).
 * - `GET /provider/auth` lists sign-in methods: API keys only.
 * - `GET /provider` lists every provider that can be connected, for the
 *   Connect dialog. Connected providers come from the engine's own catalog.
 * - Provider sign-in (OAuth) is not available on this engine yet.
 * - `GET /path` describes the workspace folder.
 *
 * Returns null for every other route.
 */
export async function localProviderRouteResponse(input: {
  request: Request;
  /** Path under the workspace mount, starting with `/opencode2`. */
  restPath: string;
  workspacePath: string;
  catalog: LocalProviderCatalog;
  ensureWritable: () => void;
  /** Mirror the changed credentials into the running engine. */
  refresh: () => Promise<void>;
}): Promise<Response | null> {
  const method = input.request.method.toUpperCase();
  const path = decodeURIComponent(input.restPath.slice("/opencode2".length)) || "/";
  const auth = /^\/auth\/([^/]+)$/.exec(path);
  if (auth?.[1]) {
    const providerId = auth[1];
    if (method === "DELETE") {
      input.ensureWritable();
      await writeLocalProviderAuth(providerId, null);
      await input.refresh();
      return Response.json(true);
    }
    if (method === "PUT" || method === "POST") {
      input.ensureWritable();
      let body: unknown;
      try { body = await input.request.json(); } catch { body = undefined; }
      if (!isRecord(body) || body.type !== "api" || typeof body.key !== "string" || !body.key.trim()) {
        throw new ApiError(400, "provider_api_key_required", "Enter an API key for this provider.");
      }
      await writeLocalProviderAuth(providerId, { type: "api", key: body.key.trim() });
      await input.refresh();
      return Response.json(true);
    }
    return null;
  }
  if (method === "GET" && path === "/provider/auth") return Response.json({});
  if (/^\/provider\/[^/]+\/oauth\/(?:authorize|callback)$/.test(path)) {
    throw new ApiError(400, "provider_sign_in_unavailable", "Sign-in for this provider is not available yet. Use an API key instead.");
  }
  if (method === "GET" && path === "/provider") {
    const all = [...await input.catalog()].flatMap(([id, entry]) => {
      if (!isRecord(entry)) return [];
      return [{
        id,
        name: typeof entry.name === "string" && entry.name.trim() ? entry.name : id,
        env: stringList(entry.env),
        source: "api",
        options: {},
        models: {},
      }];
    });
    return Response.json({ all, connected: [], default: {} });
  }
  if (method === "GET" && path === "/path") {
    return Response.json({ home: "", state: "", config: "", worktree: input.workspacePath, directory: input.workspacePath });
  }
  return null;
}
