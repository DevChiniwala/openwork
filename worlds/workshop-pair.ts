/**
 * One private Den (Gateway, workshop model, five OAuth connectors) plus ONE
 * ordinary member's Daytona desktop. Every stage is timed in status.json. A
 * failed stage does not tear the pair down: the world keeps holding so the
 * operator can inspect, fix and rerun checks. `pnpm world down` (or the
 * provider TTL) removes it. Checks run separately: worlds/workshop-pair-check.ts.
 */
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Surface } from "../evals/packages/cdp/src/index.ts";
import { control as runControl, waitUntilInteractive } from "../evals/packages/behaviors/src/desktop.ts";
import type { Den } from "../evals/packages/env/src/den.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import { chrome } from "../evals/packages/hosts/src/browser.ts";
import { createDaytonaHost, defaultDaytonaExec } from "../evals/packages/hosts/src/daytona.ts";
import { deleteSandboxes, provisionDesktopSandbox } from "../evals/packages/hosts/src/provision.ts";
import { parsePrivatePreview, privateSandboxId } from "../evals/packages/hosts/src/private-web-preview.ts";
import { hold } from "../packages/world/src/hold.ts";
import { trackResource } from "../packages/world/src/ledger.ts";
import { output, secret } from "../packages/world/src/outputs.ts";
import type { WorldOutput } from "../packages/world/src/outputs.ts";
import { targetFromEnv } from "../packages/world/src/target.ts";
import { configureWorkshop } from "./lib/workshop-setup.ts";
import { redactWorkshopDiagnostic } from "./lib/workshop-redaction.ts";
import { unlockWorkshopDesktop } from "./lib/workshop-unlock.ts";
import { linkWorkshopRuntime, selectWorkshopModel } from "./lib/workshop-models.ts";
import { connectWorkshopBrowser, foregroundWorkshopDesktop, installWorkshopBrowser, WORKSHOP_BROWSER_LAUNCHER, WORKSHOP_BROWSER_PROFILE } from "./lib/workshop-browser.ts";
import { freshComposer, verifyMember, verifySandbox, verifyViewer, workshopAccountPassword } from "./workshop-fleet.ts";

export const summary = "One private Den/Gateway with the workshop model and five OAuth connectors, plus one ordinary member's Daytona desktop; holds on failure for inspection.";
export const supportedTargets = ["daytona/linux"];
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MEMBER = "attendee01";

export interface PairStage { name: string; startedAt: string; endedAt?: string; seconds?: number; ok?: boolean; error?: string }

export function parsePairOptions(argv: readonly string[]) {
  let lifetimeMinutes = 240;
  let outputDir = "";
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag || !value || seen.has(flag)) throw new Error("Pair flags require one value each, without duplicates.");
    seen.add(flag);
    if (flag === "--lifetime" && /^\d+$/.test(value) && Number(value) >= 30 && Number(value) <= 1440) lifetimeMinutes = Number(value);
    else if (flag === "--output-dir" && isAbsolute(value)) outputDir = resolve(value);
    else throw new Error("Use --output-dir <private absolute path outside git> and optional --lifetime 30..1440 (minutes, default 240).");
  }
  if (!outputDir) throw new Error("Pair requires --output-dir outside git (it holds a member test login and a private viewer link).");
  const rel = relative(REPO_ROOT, outputDir);
  if (rel !== ".." && !rel.startsWith(`..${sep}`)) throw new Error("Pair output directory must be outside this checkout.");
  return { lifetimeMinutes, outputDir };
}

/** Two 4 CPU / 8 GiB snapshot sandboxes at list price, plus disk. */
export function pairInfrastructureUsd(lifetimeMinutes: number): number {
  return 2 * 4 * 0.083 * lifetimeMinutes / 60 + 2 * 12 / 21 * lifetimeMinutes / 1440;
}

async function privateDirectory(path: string) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()) {
    throw new Error("Output directory must be caller-owned, mode 0700, and not a symlink.");
  }
  const canonical = await realpath(path);
  for (let directory = canonical; directory !== dirname(directory); directory = dirname(directory)) {
    const git = await lstat(join(directory, ".git")).then(() => true, () => false);
    if (git) throw new Error("Pair output directory must not be inside any Git worktree.");
  }
}
async function privateJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
async function screenshot(surface: Surface, path: string) {
  const image: unknown = await surface.client.send("Page.captureScreenshot", { format: "png" });
  if (typeof image !== "object" || image === null || !("data" in image) || typeof image.data !== "string") return;
  await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parsePairOptions(argv);
  const target = targetFromEnv();
  if (target.provider !== "daytona" || target.os !== "linux") throw new Error("Workshop pair supports only --place daytona --os linux.");
  const upstreamKey = process.env.OPENAI_API_KEY;
  if (!upstreamKey?.trim()) throw new Error("Fetch OPENAI_API_KEY into the controller environment before starting.");
  if (pairInfrastructureUsd(options.lifetimeMinutes) > 180) throw new Error("Pair exceeds the approved infrastructure ceiling.");
  await privateDirectory(options.outputDir);
  const place = resolvePlace();
  const base = place.denBase();
  if (base.kind !== "daytona" || !/^[a-f0-9]{40}$/.test(base.ref)) throw new Error("Pin OPENWORK_EVAL_REF to a full pushed commit SHA.");

  const startedAtMs = Date.now();
  const deadline = startedAtMs + options.lifetimeMinutes * 60_000;
  const remaining = () => Math.max(60, Math.min(86400, Math.floor((deadline - Date.now()) / 1000)));
  const runId = randomBytes(6).toString("hex");
  const hostEmail = `host-${runId}@workshop.test`;
  const hostPassword = workshopAccountPassword();
  const memberPassword = workshopAccountPassword();
  const privateValues = [upstreamKey, hostPassword, memberPassword];
  const redact = (text: string) => redactWorkshopDiagnostic(text, privateValues);
  const stages: PairStage[] = [];
  const status: Record<string, unknown> = { runId, ref: base.ref, startedAt: new Date(startedAtMs).toISOString(), expiresAt: new Date(deadline).toISOString(), ready: false, stages };
  const statusPath = join(options.outputDir, "status.json");
  const control: Record<string, unknown> = { runId, ref: base.ref, member: MEMBER, expiresAt: status.expiresAt };
  const controlPath = join(options.outputDir, "control.json");
  const outputs: Record<string, WorldOutput> = { ref: output(base.ref), status: output(statusPath), control: output(controlPath, { note: "Private: member test login, sandbox ids, viewer link" }) };
  let diagnostic: Surface | undefined;
  async function stage<T>(name: string, run: () => Promise<T>): Promise<T> {
    const entry: PairStage = { name, startedAt: new Date().toISOString() };
    stages.push(entry); await privateJson(statusPath, status);
    console.log(`Workshop pair: ${name}…`);
    const t0 = Date.now();
    try {
      const value = await run();
      Object.assign(entry, { ok: true, endedAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000) });
      console.log(`Workshop pair: ${name} ok (${entry.seconds}s).`);
      return value;
    } catch (error) {
      Object.assign(entry, { ok: false, endedAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), error: redact(error instanceof Error ? error.message : String(error)).slice(0, 4000) });
      if (diagnostic) await screenshot(diagnostic, join(options.outputDir, `failed-${name}.png`)).catch(() => {});
      throw error;
    } finally { await privateJson(statusPath, status); }
  }

  await using stack = new AsyncDisposableStack();
  let failure: unknown;
  try {
    const { server } = await import("../evals/packages/env/src/den.ts");
    const { app } = await import("../evals/packages/env/src/desktop-app.ts");
    let den!: Den;
    await stage("den", async () => {
      const oldEmail = process.env.OPENWORK_EVAL_DEMO_EMAIL, oldPassword = process.env.OPENWORK_EVAL_DEMO_PASSWORD;
      process.env.OPENWORK_EVAL_DEMO_EMAIL = hostEmail; process.env.OPENWORK_EVAL_DEMO_PASSWORD = hostPassword;
      try {
        den = stack.use(await server({ place, org: { name: `Workshop ${runId}`, admin: { email: hostEmail, password: hostPassword, name: "Workshop host" },
          members: { [MEMBER]: { email: `${MEMBER}-${runId}@workshop.test`, name: "Attendee 01", password: memberPassword } } },
          daytonaPrivate: true, daytonaSeedDemo: false, daytonaTtlMinutes: Math.floor(remaining() / 60), daytonaAutoStopMinutes: 0, daytonaPreviewExpirySeconds: remaining(),
          env: { OPENWORK_DEV_MODE: "0", OPENWORK_WORKSHOP_PRIVATE_COHOST: "1", DEN_REQUIRE_EMAIL_VERIFICATION: "false", GATEWAY_ENABLED: "true", GATEWAY_PORT: "8791",
            GATEWAY_EGRESS_ALLOWED_ORIGINS: "https://api.openai.com", DEN_DB_ENCRYPTION_KEY: randomBytes(32).toString("hex"), BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
            GATEWAY_WEBHOOK_SECRET: randomBytes(32).toString("hex"), DEN_DEMO_OWNER_EMAIL: hostEmail, DEN_DEMO_OWNER_PASSWORD: hostPassword,
            RESEND_API_KEY: "", SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "", EMAIL_FROM: "" } }));
      } finally {
        if (oldEmail === undefined) delete process.env.OPENWORK_EVAL_DEMO_EMAIL; else process.env.OPENWORK_EVAL_DEMO_EMAIL = oldEmail;
        if (oldPassword === undefined) delete process.env.OPENWORK_EVAL_DEMO_PASSWORD; else process.env.OPENWORK_EVAL_DEMO_PASSWORD = oldPassword;
      }
      privateValues.push(den.admin.token, ...Object.values(den.members).map((member) => member.token));
      if (den.placement?.kind !== "daytona") throw new Error("Den has no owned Daytona placement.");
      const backend = await verifySandbox(den.placement.sandboxId);
      await trackResource({ kind: "daytona", id: backend.id, label: "workshop-pair-den" });
      for (const path of ["/v1/dev/emails", "/v1/dev/emails/last"]) {
        const response = await fetch(`${den.ref.apiUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
        if (response.status !== 404) throw new Error("Den exposed development email routes.");
      }
      Object.assign(control, { denSandbox: backend.id, denApiUrl: den.ref.apiUrl, denWebUrl: den.ref.webUrl });
    });
    const member = den.members[MEMBER];
    if (!member) throw new Error("Member was not provisioned.");
    const setup = await stage("models-and-connectors", () => configureWorkshop(den, { upstreamKey, allowanceUsd: 5, attendees: 1 }));
    const seat = setup.members.find((entry) => entry.key === MEMBER);
    if (!seat) throw new Error("Member allowance/model setup missing.");
    Object.assign(control, { orgId: setup.orgId, memberId: seat.memberId, modelId: seat.modelId, connections: setup.connections,
      memberLogin: { email: member.email, password: memberPassword, token: member.token, apiUrl: member.apiUrl, webUrl: member.webUrl } });
    await privateJson(controlPath, control);
    await stage("member-budget", () => verifyMember(member, setup.orgId, seat.memberId));

    const desktopId = await stage("desktop-sandbox", async () => {
      const provisioned = await provisionDesktopSandbox({ ref: base.ref, name: `workshop-pair-${runId}`, private: true, secrets: false,
        ttlMinutes: Math.floor(remaining() / 60), autoStopMinutes: 0, log: () => {},
        onCreated: async (sandbox) => {
          stack.defer(() => deleteSandboxes([sandbox], { log: () => {} }));
          await trackResource({ kind: "daytona", id: sandbox, label: "workshop-pair-desktop" });
        } });
      if (!provisioned.created) throw new Error("Pair only owns newly created desktop sandboxes.");
      const id = await privateSandboxId(provisioned.sandbox);
      await verifySandbox(id);
      control.desktopSandbox = id; await privateJson(controlPath, control);
      return id;
    });
    const host = stack.use(createDaytonaHost({ sandboxId: desktopId, repoRoot: REPO_ROOT, previewExpirySeconds: remaining(), log: () => {} }));
    const browser = await stage("browser-and-five-oauth", async () => {
      await installWorkshopBrowser(desktopId);
      await unlockWorkshopDesktop(desktopId);
      const surface = stack.use(await chrome({ name: "workshop-pair", host, profileDir: WORKSHOP_BROWSER_PROFILE, headless: false, startUrl: "about:blank" }));
      diagnostic = surface;
      const oauth = await connectWorkshopBrowser(surface, member, setup.orgId, setup.connections);
      control.guest = oauth.guest; await privateJson(controlPath, control);
      return surface;
    });
    const desktop = await stage("desktop-signed-in", async () => {
      const surface = stack.use(await app({ den, place, host, as: MEMBER, enterpriseActivated: true, workspacePath: "/home/daytona/workshop/workspace",
        env: { VITE_DISABLE_OPENWORK_MODELS: "0", OPENWORK_ENGINE_V2_PREVIEW: "1", OPENWORK_AUTOMATION_RUNNER: "on", BROWSER: WORKSHOP_BROWSER_LAUNCHER } }));
      diagnostic = surface;
      return surface;
    });
    await stage("workshop-model-visible", async () => {
      // Record whether the plain signed-in desktop already sees the managed
      // model, before the test's runtime link + reload. If it needs them,
      // attendees signing in themselves would hit the same gap.
      // A fresh desktop opens a draft with no session id; binding needs a task.
      await runControl(desktop, "session.create_task");
      control.modelVisibleWithoutRuntimeLink = await selectWorkshopModel(desktop, seat.modelId).then(() => true, () => false);
      if (!control.modelVisibleWithoutRuntimeLink) {
        await linkWorkshopRuntime(desktop, member, setup.orgId, desktop.workspaceId);
        await desktop.client.send("Page.reload", { ignoreCache: true });
        await waitUntilInteractive(desktop, { timeoutMs: 90_000 });
        await selectWorkshopModel(desktop, seat.modelId);
      }
      await privateJson(controlPath, control);
      await foregroundWorkshopDesktop(browser, desktop);
      await freshComposer(desktop, seat.modelId);
      await screenshot(desktop, join(options.outputDir, "ready.png"));
    });
    await stage("private-interactive-viewer", async () => {
      const signed = await defaultDaytonaExec(["preview-url", desktopId, "-p", "6080", "--expires", String(remaining())], { timeoutMs: 30_000 });
      if (signed.code !== 0) throw new Error("Could not mint the private viewer link.");
      const origin = parsePrivatePreview(signed.stdout, desktopId, 6080).browserOrigin;
      const viewer = `${origin}/vnc.html?autoconnect=1&resize=scale&view_only=0&reconnect=1&reconnect_delay=2000`;
      await verifyViewer(viewer, desktopId);
      control.viewer = viewer; await privateJson(controlPath, control);
      outputs.viewer = secret(viewer, { note: "Interactive private desktop; share only with the tester" });
    });
    status.ready = true;
    status.readySeconds = Math.round((Date.now() - startedAtMs) / 1000);
    console.log(`Workshop pair: ready in ${status.readySeconds}s.`);
  } catch (error) {
    failure = error;
    status.failure = redact(error instanceof Error ? error.message : String(error)).slice(0, 4000);
    console.error(`Workshop pair: stage failed; holding for inspection. ${status.failure}`);
  }
  await privateJson(statusPath, status);
  await privateJson(controlPath, control);
  outputs.ready = output(String(status.ready));
  // Hold whether or not every stage passed. Teardown: pnpm world down workshop-pair.
  await hold({ name: "workshop-pair", outputs });
  if (failure) process.exitCode = 1;
}

if (import.meta.main) await main();
