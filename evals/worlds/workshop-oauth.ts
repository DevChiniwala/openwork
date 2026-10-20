import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { allocateFreePort } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { denForAppWeb } from "./signed-in-app-web.ts";
import { record, rows, workshopApps } from "./workshop-agent.ts";

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${name}`);
  return value;
}

/** Real private gateway, real Den and two independent headless browsers. No inference runtime. */
export async function workshopOauth(seed: Seed) {
  const resources = new AsyncDisposableStack();
  try {
    const marker = `oauth-${randomBytes(5).toString("hex")}`;
    // Seed has no secret/redact registration API. Keep generated passwords closure-only,
    // never include them in evidence, and type them using the sensitive browser channel.
    const participants = [
      { id: "proof-a", name: "Avery Workshop", token: randomBytes(32).toString("base64url") },
      { id: "proof-b", name: "Riley Workshop", token: randomBytes(32).toString("base64url") },
    ];
    const origin = `http://127.0.0.1:${await allocateFreePort()}`;
    const child = spawn(process.execPath, [fileURLToPath(new URL("../packages/open-workplace/src/workshop.mjs", import.meta.url))], {
      // Never pass host provider keys to the private gateway or its service workers.
      env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: new URL(origin).port, PUBLIC_URL: origin, OPEN_WORKPLACE_PARTICIPANTS: JSON.stringify(participants) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume(); child.stderr.resume();
    resources.defer(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
        child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM");
      });
    });
    const deadline = Date.now() + 30_000;
    while (!await fetch(`${origin}/health`).then((response) => response.ok).catch(() => false)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error("Private workshop gateway did not become healthy");
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    const { den } = await denForAppWeb(seed, {
      web: true, env: { DEN_ALLOW_PRIVATE_MCP_URLS: "1", RESEND_API_KEY: "", SMTP_HOST: "" },
      org: { name: marker, members: { a: { name: "Avery Workshop" }, b: { name: "Riley Workshop" } } },
    });
    const a = den.members.a; const b = den.members.b;
    if (!a || !b) throw new Error("Missing independent Den members");
    const members = { a, b };
    const connections: { id: string; app: string; url: string }[] = [];
    for (const app of workshopApps) {
      const url = `${origin}/${app}/mcp`;
      const result = await seed.api(den.admin, "/v1/mcp-connections", {
        method: "POST", body: JSON.stringify({ name: `Workshop ${app}`, url, authType: "oauth", credentialMode: "per_member", exposeDirectly: true, access: { orgWide: true } }),
      });
      if (!result.response.ok || !record(result.body)) throw new Error(`Create ${app}: HTTP ${result.response.status}`);
      connections.push({ id: requiredString(result.body.id, "connection id"), app, url });
    }
    const webA = await seed.web({ den, signedInAs: a, startPath: "/dashboard/your-connections", headless: true });
    const webB = await seed.web({ den, signedInAs: b, startPath: "/dashboard/your-connections", headless: true });
    const org = await seed.api(a, "/v1/org");
    const orgId = record(org.body) && record(org.body.organization) ? requiredString(org.body.organization.id, "organization id") : "";
    const tokens = new Map<"a" | "b", string>();
    for (const person of ["a", "b"] as const) {
      const minted = await seed.api(members[person], "/v1/mcp/token", { method: "POST", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
      if (!minted.response.ok || !record(minted.body)) throw new Error("Cannot mint member MCP token");
      tokens.set(person, requiredString(minted.body.token, "member MCP token"));
    }
    let rpcId = 0;
    const call = async (person: "a" | "b", name: string, args: Record<string, unknown>) => {
      const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
        method: "POST", headers: { authorization: `Bearer ${tokens.get(person)}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`Den MCP ${name}: HTTP ${response.status}`);
      const raw = await response.text();
      const data = raw.split("\n").find((line) => line.startsWith("data:"));
      const frame: unknown = JSON.parse(data ? data.slice(5) : raw);
      if (!record(frame) || frame.error || !record(frame.result)) throw new Error(`Den MCP ${name}: invalid response`);
      return frame.result;
    };
    return {
      den, webA, webB, origin, marker, connections,
      accessCode(person: "a" | "b") { return requiredString(participants[person === "a" ? 0 : 1]?.token, "generated workshop password"); },
      async oauthStart(person: "a" | "b", connection: string) {
        const result = await seed.api(members[person], `/v1/mcp-connections/${connection}/connect/start`);
        if (!result.response.ok || !record(result.body)) throw new Error(`Den OAuth start: HTTP ${result.response.status}`);
        return requiredString(result.body.authorizeUrl, "authorization URL");
      },
      async connection(person: "a" | "b", id: string) {
        const result = await seed.api(members[person], "/v1/mcp-connections?scope=usable");
        return record(result.body) ? rows(result.body.connections).find((entry) => entry.id === id) : undefined;
      },
      async drive(person: "a" | "b", tool: string, body: Record<string, unknown>) {
        const drive = connections.find((connection) => connection.app === "drive");
        if (!drive) throw new Error("Missing Drive connection");
        // Discover the exact capability and schema, then execute through Den using
        // the caller's member token and the browser-authorized downstream OAuth grant.
        const found = await call(person, "search_capabilities", { query: tool, type: "mcp", limit: 20 });
        const structured = found.structuredContent;
        const matches = record(structured) ? rows(structured.matches) : [];
        const match = matches.find((entry) => entry.name === `mcp:${drive.id}:${tool}`);
        if (!match) throw new Error(`Den did not discover Drive ${tool}`);
        return call(person, "execute_capability", { name: match.name, schemaDigest: match.schemaDigest, body });
      },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
