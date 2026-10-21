export const summary = "A disposable workshop: one dev-mode Den with AI Gateway, the private Open Workplace gateway, and N signed-in attendee desktops (-- --count N).";
export const supportedTargets = ["local/host", "daytona/linux"];

import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { allocateFreePort } from "../evals/packages/cdp/src/index.ts";
import { denFetch } from "../evals/packages/behaviors/src/den.ts";
import { app } from "../evals/packages/env/src/desktop-app.ts";
import type { App } from "../evals/packages/env/src/desktop-app.ts";
import { server } from "../evals/packages/env/src/den.ts";
import type { Den } from "../evals/packages/env/src/den.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import type { Place } from "../evals/packages/env/src/place.ts";
import { daytonaSandbox } from "../evals/packages/hosts/src/resolve.ts";
import { progress } from "../packages/world/src/events.ts";
import { hold } from "../packages/world/src/hold.ts";
import { resolveStage } from "../packages/world/src/stage.ts";
import { targetFromEnv } from "../packages/world/src/target.ts";
import { ACME_ENCRYPTION_KEY, startAcmeGateway } from "./lib/acme-gateway.ts";
import { waitForNoVnc } from "./lib/preview.ts";
import {
  createWorkshopConnections, probeAutomaticJoin, probeGatewayHealth, startDaytonaGateway, startLocalGateway, verifyWorkshopConnections,
} from "./lib/workshop-gateway.ts";
import type { WorkplaceGateway, WorkshopConnection } from "./lib/workshop-gateway.ts";
import { provisionWorkshopModel } from "./lib/workshop-model.ts";
import { allocateDesktops, attendeeKeys, attendeeName, parseWorkshopArgs, runPreflight, workshopOutputs } from "./lib/workshop-plan.ts";
import type { WorkshopOptions } from "./lib/workshop-plan.ts";

const steps = progress();
const DAYTONA_AI_GATEWAY_PORT = 8791;
/** Like preview-full: people see OpenWork Models, and the desktop runs its own disposable Den's Automations. */
const ATTENDEE_APP_ENV = { VITE_DISABLE_OPENWORK_MODELS: "0", OPENWORK_AUTOMATION_RUNNER: "on" };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertIsolatedInfrastructure(): void {
  if (["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DAYTONA_DEN_SANDBOX", "OPENWORK_EVAL_DAYTONA_DESKTOP_SANDBOX", "OPENWORK_EVAL_DAYTONA_SANDBOX"].some((key) => process.env[key]?.trim())) {
    throw new Error("The workshop world owns all of its infrastructure. Unset the OPENWORK_EVAL_* reuse overrides before starting.");
  }
}

/** Den and desktops build the same reviewed commit: an explicit OPENWORK_EVAL_REF, else today's origin/dev. */
async function pinDaytonaRef(): Promise<string> {
  const configured = process.env.OPENWORK_EVAL_REF?.trim();
  if (configured) return configured;
  const { stdout } = await promisify(execFile)("git", ["ls-remote", "--exit-code", "origin", "refs/heads/dev"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 30_000,
  }).catch((cause: unknown) => { throw new Error("Could not resolve origin/dev for the workshop Den. Set OPENWORK_EVAL_REF to a pushed commit SHA.", { cause }); });
  const ref = stdout.trim().split(/\s+/)[0];
  if (!ref || !/^[0-9a-f]{40}$/.test(ref)) throw new Error("origin/dev did not resolve to a full commit SHA.");
  process.env.OPENWORK_EVAL_REF = ref;
  return ref;
}

async function bootDen(stack: AsyncDisposableStack, place: Place, options: { orgName: string; keys: readonly string[]; nonce: string }) {
  // Dev-mode Den on purpose: fictional accounts, no email delivery, no production-only origin/password rules.
  const base: Record<string, string> = { OPENWORK_DEV_MODE: "1", DEN_REQUIRE_EMAIL_VERIFICATION: "false", RESEND_API_KEY: "", SMTP_HOST: "", DEN_DB_ENCRYPTION_KEY: ACME_ENCRYPTION_KEY };
  let localGateway: { baseUrl: string; env: Record<string, string> } | undefined;
  let env: Record<string, string>;
  if (place.kind === "local") {
    const port = await allocateFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    localGateway = { baseUrl, env: { GATEWAY_ENABLED: "true", GATEWAY_PORT: String(port), GATEWAY_PROXY_BASE_URL: baseUrl, GATEWAY_PUBLIC_BASE_URL: baseUrl, GATEWAY_WEBHOOK_SECRET: randomUUID(), DEN_DB_ENCRYPTION_KEY: ACME_ENCRYPTION_KEY } };
    // The workplace gateway listens on loopback next to Den.
    env = { ...base, ...localGateway.env, DEN_ALLOW_PRIVATE_MCP_URLS: "1" };
  } else {
    env = { ...base, GATEWAY_ENABLED: "true", GATEWAY_PORT: String(DAYTONA_AI_GATEWAY_PORT) };
  }
  const den = stack.use(await server({
    place, web: true, daytonaAutoStopMinutes: 0, env,
    org: {
      name: options.orgName,
      admin: { name: "Workshop host", email: `host-${options.nonce}@example.test` },
      members: Object.fromEntries(options.keys.map((key) => [key, { name: attendeeName(key), email: `${key}-${options.nonce}@example.test` }])),
    },
  }));
  if (localGateway) {
    if (!den.database) throw new Error("The local workshop Den has no isolated database for its AI Gateway.");
    await startAcmeGateway(stack, den.database.url, localGateway);
  }
  const aiGatewayUrl = localGateway?.baseUrl ?? den.gateway?.publicUrl;
  return { den, aiGatewayUrl };
}

async function orgIdFor(den: Den, name: string): Promise<string> {
  const orgs = await denFetch(den.admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${den.admin.token}` } });
  const org = record(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs.find((entry) => record(entry) && entry.name === name) : undefined;
  if (!orgs.response.ok || !record(org) || typeof org.id !== "string") throw new Error(`Den did not list the workshop organization (HTTP ${orgs.response.status}).`);
  return org.id;
}

async function attendeeViewer(place: Place, desktop: App): Promise<{ viewerUrl?: string; sandbox?: string }> {
  if (place.kind === "local") return {};
  const sandbox = desktop.handle.sandboxId;
  if (!sandbox) throw new Error("Attendee desktop did not report its Daytona sandbox.");
  const host = daytonaSandbox(sandbox);
  if (!host.previewUrl) throw new Error("Daytona host cannot expose the attendee viewer.");
  const url = new URL(await host.previewUrl(6080));
  url.search = "autoconnect=1&resize=scale&reconnect=1&reconnect_delay=2000";
  await waitForNoVnc(url.href);
  return { viewerUrl: url.href, sandbox };
}

export interface WorkshopWorld {
  den: Den;
  aiGatewayUrl?: string;
  gateway: WorkplaceGateway;
  orgName: string;
  orgId: string;
  connections: WorkshopConnection[];
  outputs: ReturnType<typeof workshopOutputs>;
}

/** Den → workplace gateway → preflight → optional model → pilot desktop → remaining desktops. */
export async function boot(stack: AsyncDisposableStack, place: Place, options: WorkshopOptions, context: { stage?: string; expires?: Date } = {}): Promise<WorkshopWorld> {
  assertIsolatedInfrastructure();
  const keys = attendeeKeys(options.count);
  const nonce = randomBytes(4).toString("hex");
  const orgName = `Workshop ${context.stage ?? nonce}`;

  const denStep = steps.step("workshop-den", `Den with ${keys.length} attendee account(s)`);
  const { den, aiGatewayUrl } = await bootDen(stack, place, { orgName, keys, nonce }).catch(async (error: unknown) => {
    await denStep.fail(error instanceof Error ? error.message : String(error));
    throw error;
  });
  await denStep.ok(den.ref.webUrl);
  const orgId = await orgIdFor(den, orgName);

  const gatewayStep = steps.step("workshop-gateway", "Open Workplace gateway");
  let gateway: WorkplaceGateway;
  try {
    gateway = place.kind === "daytona"
      ? await startDaytonaGateway(stack, den, { expiresInSeconds: context.expires ? (context.expires.getTime() - Date.now()) / 1000 + 600 : 86_400 })
      : await startLocalGateway(stack);
  } catch (error) {
    await gatewayStep.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
  await gatewayStep.ok(gateway.origin);

  const secrets = [den.admin.password, den.admin.token, gateway.resetToken, process.env.OPENAI_API_KEY, ...Object.values(den.members).flatMap((member) => [member.password, member.token])];
  let connections: WorkshopConnection[] = [];
  const firstMember = keys[0] ? den.members[keys[0]] : undefined;
  const preflightStep = steps.step("workshop-preflight", "Preflight");
  await runPreflight([
    { id: "den", label: "Den is healthy", run: async () => {
      const health = await fetch(`${den.ref.apiUrl}/health`, { signal: AbortSignal.timeout(15_000) });
      if (!health.ok) throw new Error(`Den /health returned HTTP ${health.status}`);
    } },
    { id: "gateway", label: "Workplace gateway is healthy", run: () => probeGatewayHealth(gateway.origin) },
    { id: "join", label: "A new browser joins automatically", run: () => probeAutomaticJoin(gateway.origin) },
    { id: "connections", label: "Five workplace connections exist", run: async () => {
      connections = await createWorkshopConnections(den.admin, orgId, gateway.origin);
      return verifyWorkshopConnections(den.admin, orgId, connections, firstMember);
    } },
  ], { secrets }).catch(async (error: unknown) => {
    await preflightStep.fail(error instanceof Error ? error.message : String(error));
    throw error;
  });
  await preflightStep.ok(`${connections.length} connections`);

  const modelStep = steps.step("workshop-model", "Model provider");
  const model = await provisionWorkshopModel({ admin: den.admin, orgId, model: options.model, allowanceUsd: options.allowanceUsd, gatewayEnabled: Boolean(aiGatewayUrl) });
  if (model.state === "failed") {
    await modelStep.fail(model.note);
    throw new Error(model.note);
  }
  if (model.state === "skipped") await modelStep.note(`Skipped: ${model.note}`);
  else {
    if (firstMember) {
      const usable = await denFetch(firstMember, "/v1/inference-providers?scope=usable", {
        headers: { authorization: `Bearer ${firstMember.token}`, "x-openwork-org-id": orgId },
      });
      const providers = record(usable.body) && Array.isArray(usable.body.inferenceProviders) ? usable.body.inferenceProviders : [];
      const visible = providers.some((provider) => record(provider) && provider.id === model.providerId && provider.credentialStatus === "ready"
        && Array.isArray(provider.models) && provider.models.some((entry) => record(entry) && entry.upstreamModelId === options.model && typeof entry.id === "string" && entry.id.startsWith("gwm_")));
      if (!usable.response.ok || !visible) {
        await modelStep.fail("The ordinary attendee has no ready Gateway model in usable inventory.");
        throw new Error("Workshop model provisioning is incomplete: the ordinary attendee cannot use the configured model.");
      }
    }
    await modelStep.ok("Provider and allowance configured; attendee inventory checked (paid inference still unverified)");
  }

  const desktopStep = steps.step("workshop-desktops", keys.length === 0 ? "No attendee desktops (--count 0)" : `${keys.length} attendee desktop(s), pilot first`);
  const results = await allocateDesktops(keys, async (key) => {
    const desktop = await app({ den, place, as: key, env: ATTENDEE_APP_ENV, enterpriseActivated: true });
    try {
      const viewer = await attendeeViewer(place, desktop);
      stack.use(desktop);
      return viewer;
    } catch (error) {
      await desktop[Symbol.asyncDispose]();
      throw error;
    }
  }, { concurrency: options.concurrency, secrets }).catch(async (error: unknown) => {
    await desktopStep.fail(error instanceof Error ? error.message : String(error));
    throw error;
  });
  const failed = results.filter((result) => !result.ok).length;
  await desktopStep.ok(failed ? `${results.length - failed} ready, ${failed} failed` : `${results.length} ready`);

  const outputs = workshopOutputs({
    place: place.kind, stage: context.stage, denWebUrl: den.ref.webUrl, denApiUrl: den.ref.apiUrl, ...(aiGatewayUrl ? { aiGatewayUrl } : {}),
    workplaceUrl: gateway.origin, resetToken: gateway.resetToken, admin: den.admin, orgName, connections, model,
    attendees: results.map((result) => {
      const member = den.members[result.key];
      if (!member) throw new Error(`Missing Den member ${result.key}`);
      return result.ok
        ? { key: result.key, email: member.email, password: member.password, ok: true as const, ...result.value }
        : { key: result.key, email: member.email, password: member.password, ok: false as const, error: result.error };
    }),
    ...(den.placement?.kind === "daytona" ? { denSandbox: den.placement.sandboxId } : {}),
    ...(context.expires ? { expires: context.expires } : {}),
  });
  return { den, aiGatewayUrl, gateway, orgName, orgId, connections, outputs };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const target = targetFromEnv();
  if (target.provider !== "local" && target.provider !== "daytona") throw new Error("The workshop world runs on --place local or --place daytona.");
  if (target.os === "windows") throw new Error("The workshop world runs Linux desktops; drop --os windows.");
  const options = parseWorkshopArgs(argv, target.provider);
  if (target.provider === "daytona") {
    const ref = await pinDaytonaRef();
    console.error(`workshop  Den and desktops build ${ref}`);
    // Desktop sandboxes must not idle-stop mid-workshop; this world's lifetime owns teardown.
    process.env.OPENWORK_WORLD_PREVIEW_DAYTONA = "1";
  }
  const place = resolvePlace();
  const stage = resolveStage(process.env);
  const expires = options.lifetimeMinutes === 0 ? undefined : new Date(Date.now() + options.lifetimeMinutes * 60_000);
  await using stack = new AsyncDisposableStack();
  let world: WorkshopWorld;
  try {
    world = await boot(stack, place, options, { ...(stage ? { stage } : {}), ...(expires ? { expires } : {}) });
  } catch (error) {
    if (target.provider === "daytona" && process.env.OPENWORK_DAYTONA_RETAIN_FAILED === "1") {
      // An explicit diagnostic run owns provider TTL/cleanup and needs the failed
      // pilot intact, rather than losing its logs and state to stack disposal.
      stack.move();
      console.error("workshop  Failed pilot retained for repair. Inspect the world log and stop its owned sandboxes explicitly when finished.");
    }
    throw error;
  }
  const timer = expires ? setTimeout(() => process.kill(process.pid, "SIGTERM"), options.lifetimeMinutes * 60_000) : undefined;
  try {
    await hold({ name: "workshop", outputs: world.outputs });
  } finally {
    clearTimeout(timer);
  }
}

if (import.meta.main) await main();
