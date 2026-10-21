/**
 * The private Open Workplace gateway (evals/packages/open-workplace/src/workshop.mjs)
 * running inside a workshop world: a child process locally, or inside the Den
 * sandbox on Daytona behind a signed preview URL. Every browser that opens it
 * joins its own private, persisted workspace automatically (no roster, no caps).
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { allocateFreePort } from "../../evals/packages/cdp/src/index.ts";
import { denFetch } from "../../evals/packages/behaviors/src/den.ts";
import type { DenSession } from "../../evals/packages/behaviors/src/den.ts";
import type { Den } from "../../evals/packages/env/src/den.ts";
import { defaultDaytonaExec } from "../../evals/packages/hosts/src/index.ts";
import type { DaytonaExec } from "../../evals/packages/hosts/src/index.ts";
import { trackResource } from "../../packages/world/src/ledger.ts";
import { redact, WORKSHOP_APPS, type WorkshopApp } from "./workshop-plan.ts";

const SOURCE = new URL("../../evals/packages/open-workplace/src/", import.meta.url);
/** Everything workshop.mjs imports or forks; Node builtins only otherwise. */
export const GATEWAY_FILES = [
  "workshop.mjs", "workshop-auth.mjs", "workshop-html.mjs", "workshop-store.mjs", "workshop-worker.mjs",
  "microsoft365.mjs", "atlassian.mjs", "atlassian-web.mjs",
] as const;
/** Free in the Den sandbox: 3990-3993 are the demo apps, 8791 the AI Gateway. */
export const DAYTONA_GATEWAY_PORT = 3994;
const REMOTE_LABEL = "openwork-workplace-gateway";
/** Stop by pid, not `pkill -f`: the cleanup command line itself names the gateway directory. */
const REMOTE_PID = `/tmp/${REMOTE_LABEL}.pid`;
const STOP_PREVIOUS = `if [ -f ${REMOTE_PID} ]; then kill $(cat ${REMOTE_PID}) 2>/dev/null || true; rm -f ${REMOTE_PID}; fi`;
/** Daytona's browser interstitial is for people; runner probes skip it. */
const PROBE_HEADERS = { "x-daytona-skip-preview-warning": "true" };

export interface WorkplaceGateway {
  /** Browser-reachable origin; also the OAuth issuer and MCP resource base. */
  origin: string;
  resetToken: string;
  placement: "local" | "daytona";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Random reset key accepted by workshop.mjs (32-256 url-safe chars, ≥16 distinct) and workshop-reset.mjs (≤128). */
export function newResetToken(): string {
  for (;;) {
    const token = randomBytes(32).toString("base64url");
    if (new Set(token).size >= 16) return token;
  }
}

function gatewayEnv(origin: string, dataDir: string, resetToken: string, host: string, port: number): Record<string, string> {
  return {
    HOST: host, PORT: String(port), PUBLIC_URL: origin,
    OPEN_WORKPLACE_JOIN_MODE: "automatic", OPEN_WORKPLACE_DATA_DIR: dataDir, OPEN_WORKPLACE_RESET_TOKEN: resetToken,
  };
}

/** Local: a child process on loopback; Den reaches it because the world sets DEN_ALLOW_PRIVATE_MCP_URLS=1. */
export async function startLocalGateway(stack: AsyncDisposableStack): Promise<WorkplaceGateway> {
  const port = await allocateFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const resetToken = newResetToken();
  const dataDir = await mkdtemp(join(tmpdir(), "openwork-workshop-gateway-"));
  stack.defer(() => rm(dataDir, { recursive: true, force: true }));
  await trackResource({ kind: "tmpdir", id: dataDir, label: "workshop-gateway-data" });
  // Never pass host provider keys to the private gateway or its per-participant workers.
  const child = spawn(process.execPath, [fileURLToPath(new URL("workshop.mjs", SOURCE))], {
    env: { PATH: process.env.PATH, ...gatewayEnv(origin, dataDir, resetToken, "127.0.0.1", port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const capture = (chunk: Buffer) => { logs = `${logs}${chunk.toString()}`.slice(-4000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  stack.defer(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  });
  if (child.pid) await trackResource({ kind: "process", id: String(child.pid), label: "workshop-gateway", match: "workshop.mjs" });
  const deadline = Date.now() + 30_000;
  while (!await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) }).then((response) => response.ok).catch(() => false)) {
    if (child.exitCode !== null) throw new Error(`Workplace gateway exited: ${redact(logs, [resetToken]).trim() || `code ${child.exitCode}`}`);
    if (Date.now() > deadline) throw new Error("Workplace gateway did not become healthy within 30s");
    await delay(250);
  }
  return { origin, resetToken, placement: "local" };
}

/** A signed, port-bound Daytona preview origin (no query token), valid for `expiresInSeconds`. */
export function parseSignedPreviewOrigin(stdout: string, port: number): string {
  const match = stdout.match(/https:\/\/[^\s"'<>)]+/);
  if (!match) throw new Error("Daytona did not return a preview URL for the workplace gateway.");
  const url = new URL(match[0].replace(/[.,;:]+$/, ""));
  if (url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/" || !url.hostname.startsWith(`${port}-`)) {
    throw new Error("Daytona returned an unexpected workplace preview URL shape.");
  }
  return url.origin;
}

async function sandboxRun(exec: DaytonaExec, sandbox: string, script: string, context: string, secrets: readonly string[] = [], timeoutMs = 60_000): Promise<string> {
  if (script.includes("'")) throw new Error(`${context}: remote script must not contain single quotes.`);
  const result = await exec(["exec", sandbox, "--", `bash -lc '${script}'`], { timeoutMs });
  if (result.code !== 0) {
    const tail = redact(`${result.stderr}\n${result.stdout}`, secrets).split("\n").filter((line) => line.trim() && !line.includes("Version mismatch")).slice(-4).join(" ").slice(0, 400);
    throw new Error(`${context} failed (exit ${result.code})${tail ? `: ${tail}` : ""}`);
  }
  return result.stdout;
}

/** Bundles the gateway sources into one gzip+base64 JSON payload; the fingerprint names the remote directory. */
export async function gatewayBundle(): Promise<{ payload: string; fingerprint: string }> {
  const files: Record<string, string> = {};
  for (const name of GATEWAY_FILES) files[name] = await readFile(fileURLToPath(new URL(name, SOURCE)), "utf8");
  const json = JSON.stringify(files);
  return { payload: gzipSync(json).toString("base64"), fingerprint: createHash("sha256").update(json).digest("hex").slice(0, 16) };
}

/** node:sqlite (workshop-store.mjs) is unflagged from Node 22.13. */
export function nodeSupportsGateway(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  return major > 22 || (major === 22 && Number(match[2]) >= 13);
}

/**
 * Daytona: upload this checkout's gateway sources into the Den sandbox (never
 * trusting the sandbox's checkout of the provisioned ref), start it detached on
 * a fixed port, and give it the signed preview origin as PUBLIC_URL, so the same
 * origin is the browser address, the OAuth issuer and the MCP resource Den calls.
 */
export async function startDaytonaGateway(
  stack: AsyncDisposableStack,
  den: Den,
  options: { expiresInSeconds: number; exec?: DaytonaExec; log?: (line: string) => void },
): Promise<WorkplaceGateway> {
  if (den.placement?.kind !== "daytona") throw new Error("startDaytonaGateway needs a Daytona Den.");
  const sandbox = den.placement.sandboxId;
  const exec = options.exec ?? defaultDaytonaExec;
  const log = options.log ?? ((line: string) => console.error(`[workshop-gateway] ${line}`));
  const resetToken = newResetToken();
  const expires = Math.max(60, Math.min(86_400, Math.floor(options.expiresInSeconds)));
  const preview = await exec(["preview-url", sandbox, "-p", String(DAYTONA_GATEWAY_PORT), "--expires", String(expires)], { timeoutMs: 60_000 });
  if (preview.code !== 0) throw new Error("Could not create the workplace gateway preview URL.");
  const origin = parseSignedPreviewOrigin(preview.stdout, DAYTONA_GATEWAY_PORT);

  const version = (await sandboxRun(exec, sandbox, "node -p process.version", "workplace gateway Node check")).trim().split("\n").at(-1) ?? "";
  if (!nodeSupportsGateway(version)) throw new Error(`The Den sandbox has Node ${version || "(unknown)"}; the workplace gateway needs Node 22.13+ for node:sqlite.`);

  const { payload, fingerprint } = await gatewayBundle();
  const dir = `/tmp/${REMOTE_LABEL}-${fingerprint}`;
  const dataDir = `/tmp/${REMOTE_LABEL}-data`;
  log(`uploading ${GATEWAY_FILES.length} files (${Math.round(payload.length / 1024)} KiB) to ${dir}`);
  await sandboxRun(exec, sandbox, `${STOP_PREVIOUS}; rm -rf ${dir}; mkdir -p ${dir}/parts ${dir}/src; install -d -m 700 ${dataDir}`, "workplace gateway reset");
  const chunk = 8 * 1024;
  const parts = Array.from({ length: Math.ceil(payload.length / chunk) }, (_, index) => payload.slice(index * chunk, (index + 1) * chunk));
  const queue = parts.map((part, index) => ({ part, index }));
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      await sandboxRun(exec, sandbox, `printf %s ${item.part} > ${dir}/parts/${String(item.index).padStart(5, "0")}`, "workplace gateway upload");
    }
  }));
  const unpack = `const fs=require("fs"),z=require("zlib");const files=JSON.parse(z.gunzipSync(Buffer.from(fs.readFileSync(0,"utf8"),"base64")));for(const [n,s] of Object.entries(files)){if(!/^[a-z0-9-]+\\.mjs$/.test(n))process.exit(3);fs.writeFileSync("${dir}/src/"+n,s)}console.log(Object.keys(files).length)`;
  const unpacked = await sandboxRun(exec, sandbox, `cat ${dir}/parts/* | node -e ${JSON.stringify(unpack).replace(/\$/g, "\\$")} && rm -rf ${dir}/parts`, "workplace gateway unpack");
  if (unpacked.trim().split("\n").at(-1) !== String(GATEWAY_FILES.length)) throw new Error("Workplace gateway sources did not unpack completely.");

  // Values travel base64-encoded so the remote command line never carries the reset key in clear text,
  // and the gateway gets a minimal environment: none of the sandbox's Den configuration.
  const env = Object.fromEntries(Object.entries(gatewayEnv(origin, dataDir, resetToken, "0.0.0.0", DAYTONA_GATEWAY_PORT))
    .map(([key, value]) => [key, Buffer.from(value, "utf8").toString("base64")]));
  const detach = `cd ${dir}; python3 - <<PYEOF
import base64, os, subprocess
encoded = ${JSON.stringify(env)}
env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/tmp")}
env.update({key: base64.b64decode(value).decode("utf-8") for key, value in encoded.items()})
log = open("${dir}/gateway.log", "ab", buffering=0)
child = subprocess.Popen(["node", "${dir}/src/workshop.mjs"], cwd="${dir}", env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
open("${REMOTE_PID}", "w").write(str(child.pid))
PYEOF
echo detached`;
  try {
    await sandboxRun(exec, sandbox, detach, "workplace gateway start", [resetToken]);
  } catch (error) {
    // Never echo the start command; it contains the (encoded) reset key.
    throw new Error(`Workplace gateway did not start: ${redact(error instanceof Error ? error.message : String(error), [resetToken])}`);
  }
  // The Den disposer usually deletes the whole sandbox first; then there is nothing left to stop.
  stack.defer(() => sandboxRun(exec, sandbox, `${STOP_PREVIOUS}; rm -rf ${dir} ${dataDir}`, "workplace gateway stop").then(() => undefined, () => undefined));

  const deadline = Date.now() + 90_000;
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`, { headers: PROBE_HEADERS, signal: AbortSignal.timeout(5000) });
      if (response.ok) return { origin, resetToken, placement: "daytona" };
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(2000);
  }
  const tail = await sandboxRun(exec, sandbox, `tail -20 ${dir}/gateway.log 2>&1 || true`, "workplace gateway log").catch(() => "");
  throw new Error(`Workplace gateway is not reachable at its preview URL (${last}). Log tail: ${redact(tail, [resetToken]).trim().slice(-800)}`);
}

/** /health reports automatic join, and OAuth protected-resource metadata names this exact origin. */
export async function probeGatewayHealth(origin: string, fetcher: typeof fetch = fetch): Promise<string> {
  const health = await fetcher(`${origin}/health`, { headers: PROBE_HEADERS, signal: AbortSignal.timeout(10_000) });
  const body: unknown = await health.json().catch(() => null);
  if (!health.ok || !record(body) || body.ok !== true) throw new Error(`gateway /health returned HTTP ${health.status}`);
  if (body.joinMode !== "automatic") throw new Error(`gateway join mode is ${String(body.joinMode)}, expected automatic`);
  const metadata = await fetcher(`${origin}/.well-known/oauth-protected-resource/outlook/mcp`, { headers: PROBE_HEADERS, signal: AbortSignal.timeout(10_000) });
  const resource: unknown = await metadata.json().catch(() => null);
  if (!metadata.ok || !record(resource) || resource.resource !== `${origin}/outlook/mcp`) {
    throw new Error("gateway OAuth metadata does not name its public origin; PUBLIC_URL and the browser address differ");
  }
  return `${String(body.storage)} storage`;
}

/**
 * A brand-new browser joins automatically, gets its own fictional identity, then
 * the probe resets that workspace and forgets the browser so it leaves no data.
 */
export async function probeAutomaticJoin(origin: string, fetcher: typeof fetch = fetch): Promise<string> {
  const joined = await fetcher(`${origin}/login?next=%2F`, { redirect: "manual", headers: { ...PROBE_HEADERS, accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
  const cookie = joined.headers.get("set-cookie")?.split(";")[0];
  if (joined.status !== 303 || !cookie) throw new Error(`automatic join returned HTTP ${joined.status}${cookie ? "" : " without a browser session"}`);
  const headers = { ...PROBE_HEADERS, cookie, origin };
  const me = await fetcher(`${origin}/v1.0/me`, { headers, signal: AbortSignal.timeout(30_000) });
  const person: unknown = await me.json().catch(() => null);
  if (!me.ok || !record(person) || typeof person.mail !== "string") throw new Error(`a joined browser could not open its private Outlook (HTTP ${me.status})`);
  const reset = await fetcher(`${origin}/_workshop/reset`, { method: "POST", redirect: "manual", headers, signal: AbortSignal.timeout(30_000) });
  if (reset.status !== 303) throw new Error(`per-attendee reset returned HTTP ${reset.status}`);
  const left = await fetcher(`${origin}/logout`, { method: "POST", redirect: "manual", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: "", signal: AbortSignal.timeout(15_000) });
  if (left.status !== 303) throw new Error(`forgetting the probe browser returned HTTP ${left.status}`);
  return "join, private data, reset and leave";
}

export interface WorkshopConnection { app: WorkshopApp; id: string; url: string; signIn: string }

export function connectionName(app: WorkshopApp): string {
  return `Workshop ${app[0]?.toUpperCase()}${app.slice(1)}`;
}

/** Five org-wide OAuth connections, one private grant per member, tools exposed directly. */
export async function createWorkshopConnections(admin: DenSession, orgId: string, origin: string): Promise<WorkshopConnection[]> {
  const headers = { authorization: `Bearer ${admin.token}`, "x-openwork-org-id": orgId };
  const connections: WorkshopConnection[] = [];
  for (const app of WORKSHOP_APPS) {
    const url = `${origin}/${app}/mcp`;
    const created = await denFetch(admin, "/v1/mcp-connections", {
      method: "POST", headers,
      body: JSON.stringify({ name: connectionName(app), url, authType: "oauth", credentialMode: "per_member", exposeDirectly: true, access: { orgWide: true } }),
    });
    const body = created.body;
    const links = record(body) && record(body.links) ? body.links : {};
    if (!created.response.ok || !record(body) || typeof body.id !== "string" || typeof links.signIn !== "string") {
      const code = record(body) && typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? ` (${body.error})` : "";
      throw new Error(`Den refused the ${app} connection: HTTP ${created.response.status}${code}`);
    }
    connections.push({ app, id: body.id, url, signIn: links.signIn });
  }
  return connections;
}

/** Every connection is listed for the org and, when a member exists, usable by that ordinary member. */
export async function verifyWorkshopConnections(admin: DenSession, orgId: string, expected: readonly WorkshopConnection[], member?: DenSession): Promise<string> {
  for (const [who, session, path] of [["host", admin, "/v1/mcp-connections"], ...(member ? [["a member", member, "/v1/mcp-connections?scope=usable"] as const] : [])] as const) {
    const listed = await denFetch(session, path, { headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId } });
    const rows = record(listed.body) && Array.isArray(listed.body.connections) ? listed.body.connections.filter(record) : [];
    const ids = new Set(rows.map((row) => row.id));
    const missing = expected.filter((connection) => !ids.has(connection.id)).map((connection) => connection.app);
    if (!listed.response.ok || missing.length > 0) throw new Error(`${who} cannot see ${missing.join(", ") || `connections (HTTP ${listed.response.status})`}`);
  }
  return `${expected.length} connections${member ? ", visible to members" : ""}`;
}
