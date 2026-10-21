/**
 * Checks against a running workshop pair (worlds/workshop-pair.ts). Each command
 * attaches to the live desktop and browser, acts like the attendee, records a
 * receipt and screenshot under <output-dir>/checks/, and leaves the pair running.
 *
 *   node worlds/workshop-pair-check.ts <output-dir> status|task|steer|stop|unlock|reset
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attachSurface, browserScript, probeAppStateOnSurface } from "../evals/packages/cdp/src/index.ts";
import type { Surface } from "../evals/packages/cdp/src/index.ts";
import { control, evalIn, waitFor } from "../evals/packages/behaviors/src/desktop.ts";
import { readComposerState, sendComposerMessage, waitForAssistantReply, writeComposerText } from "../evals/packages/behaviors/src/composer.ts";
import { denFetch } from "../evals/packages/behaviors/src/den.ts";
import type { DenSession } from "../evals/packages/behaviors/src/den.ts";
import { defaultDaytonaExec } from "../evals/packages/hosts/src/daytona.ts";
import { parsePrivatePreview } from "../evals/packages/hosts/src/private-web-preview.ts";
import { foregroundWorkshopDesktop, WORKPLACE_ORIGIN } from "./lib/workshop-browser.ts";
import { unlockWorkshopDesktop } from "./lib/workshop-unlock.ts";
import { typeThroughWorkshopViewer } from "./lib/workshop-viewer.ts";
import { freshComposer, verifyMember, verifyViewer } from "./workshop-fleet.ts";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown, field: string): string {
  assert.ok(record(value) && typeof value[field] === "string" && value[field], `control.json is missing ${field}; did the pair reach that stage?`);
  return String(value[field]);
}
const STOP = /^(stop|stop task|stop generating)$/i;

async function attach(id: string, port: number, kind: "chrome" | "electron") {
  const result = await defaultDaytonaExec(["preview-url", id, "-p", String(port), "--expires", "3600"], { timeoutMs: 30_000 });
  assert.equal(result.code, 0, "Private control endpoint could not be minted");
  const cdpUrl = parsePrivatePreview(result.stdout, id, port).browserOrigin;
  return attachSurface({ name: `workshop-pair-${kind}`, hostKind: "daytona", sandboxId: id, kind, cdpUrl });
}
async function capture(surface: Surface, path: string) {
  const image: unknown = await surface.client.send("Page.captureScreenshot", { format: "png" });
  if (record(image) && typeof image.data === "string") await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
}
async function busy(desktop: Surface): Promise<boolean> {
  const value = await evalIn(desktop, browserScript((pattern) => [...document.querySelectorAll("button")]
    .some((button) => new RegExp(pattern, "i").test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()) && !button.disabled), [STOP.source]));
  return value === true;
}
async function waitIdle(desktop: Surface, timeoutMs: number, label: string) {
  await waitFor(desktop, browserScript((pattern) => ![...document.querySelectorAll("button")]
    .some((button) => new RegExp(pattern, "i").test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()))
    && !document.querySelector('[data-status="pending"], [data-status="running"]'), [STOP.source]), { timeoutMs, label });
}
/** Trusted keyboard Ctrl+Enter, exactly what the attendee presses to steer. */
async function pressCtrlEnter(desktop: Surface) {
  const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 2 };
  await desktop.client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await desktop.client.send("Input.dispatchKeyEvent", { type: "char", ...base, text: "\r" });
  await desktop.client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
async function userMessages(desktop: Surface): Promise<number> {
  const value = await evalIn(desktop, () => document.querySelectorAll('[data-message-role="user"]').length);
  return typeof value === "number" ? value : 0;
}

export async function main(argv = process.argv.slice(2)) {
  const [outputDir, command] = argv;
  assert.ok(outputDir && command && ["prepare", "status", "task", "steer", "stop", "unlock", "reset"].includes(command),
    "Usage: node worlds/workshop-pair-check.ts <output-dir> prepare|status|task|steer|stop|unlock|reset");
  const pair: unknown = JSON.parse(await readFile(join(outputDir, "control.json"), "utf8"));
  const desktopId = text(pair, "desktopSandbox");
  const orgId = text(pair, "orgId"), memberId = text(pair, "memberId"), modelId = text(pair, "modelId");
  assert.ok(record(pair) && record(pair.memberLogin));
  const login = pair.memberLogin;
  const member: DenSession = { email: text(login, "email"), password: text(login, "password"), token: text(login, "token"), apiUrl: text(login, "apiUrl"), webUrl: text(login, "webUrl") };
  const checks = join(outputDir, "checks");
  await mkdir(checks, { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  await using desktop = await attach(desktopId, 9825, "electron");
  await using browser = await attach(desktopId, 9222, "chrome");
  const receipt: Record<string, unknown> = { command, startedAt: new Date(startedAt).toISOString() };
  const finish = async (passed: boolean, extra: Record<string, unknown> = {}) => {
    Object.assign(receipt, extra, { passed, seconds: Math.round((Date.now() - startedAt) / 1000) });
    await capture(desktop, join(checks, `${command}.png`)).catch(() => {});
    await writeFile(join(checks, `${command}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    console.log(`${passed ? "PASS" : "FAIL"} ${command} (${receipt.seconds}s) — receipt ${join(checks, `${command}.json`)}`);
  };
  try {
    if (command === "prepare") {
      // Finish a pair whose last setup stages failed: fresh task on the workshop
      // model, then a private interactive viewer link recorded in control.json.
      await foregroundWorkshopDesktop(browser, desktop);
      await freshComposer(desktop, modelId);
      const expires = Math.max(60, Math.min(86400, Math.floor((Date.parse(text(pair, "expiresAt")) - Date.now()) / 1000)));
      const signed = await defaultDaytonaExec(["preview-url", desktopId, "-p", "6080", "--expires", String(expires)], { timeoutMs: 30_000 });
      assert.equal(signed.code, 0, "Could not mint the private viewer link.");
      const origin = parsePrivatePreview(signed.stdout, desktopId, 6080).browserOrigin;
      const viewer = `${origin}/vnc.html?autoconnect=1&resize=scale&view_only=0&reconnect=1&reconnect_delay=2000`;
      await verifyViewer(viewer, desktopId);
      Object.assign(pair, { viewer, preparedAt: new Date().toISOString() });
      await writeFile(join(outputDir, "control.json"), `${JSON.stringify(pair, null, 2)}\n`, { mode: 0o600 });
      return await finish(true, { viewerVerified: true, freshComposerOnWorkshopModel: true });
    }
    if (command === "status") {
      const auth = await control(desktop, "auth.status");
      const app = await probeAppStateOnSurface(desktop);
      const models = await control(desktop, "models.list", { workspaceId: app.workspaceId });
      const listed = record(models) && Array.isArray(models.models) ? models.models.filter(record) : [];
      const usable = await denFetch(member, "/v1/mcp-connections?scope=usable", { headers: { authorization: `Bearer ${member.token}`, "x-openwork-org-id": orgId } });
      const connections = record(usable.body) && Array.isArray(usable.body.connections) ? usable.body.connections.filter(record) : [];
      const budget = await verifyMember(member, orgId, memberId);
      const facts = {
        signedInAs: record(auth) && record(auth.user) ? auth.user.email : null,
        workshopModelAvailable: listed.some((model) => model.modelId === modelId && model.available === true),
        connectedForMe: connections.map((connection) => ({ name: connection.name, connected: connection.connectedForMe === true })),
        budget: { usedMicroUsd: budget.usedMicroUsd, allowanceMicroUsd: budget.allowanceMicroUsd },
        busy: await busy(desktop),
      };
      const passed = facts.signedInAs === member.email && facts.workshopModelAvailable && facts.connectedForMe.length === 5 && facts.connectedForMe.every((entry) => entry.connected);
      return await finish(passed, { facts });
    }
    if (command === "unlock") {
      await unlockWorkshopDesktop(desktopId);
      await foregroundWorkshopDesktop(browser, desktop);
      await freshComposer(desktop);
      const marker = `unlock-${Date.now().toString(36)}`;
      await typeThroughWorkshopViewer(text(pair, "viewer"), marker);
      await waitFor(desktop, browserScript((marker) => (document.querySelector<HTMLElement>('[contenteditable="true"]')?.innerText ?? "").includes(marker), [marker]),
        { timeoutMs: 30_000, label: "keyboard input through the private viewer reached the composer" });
      await capture(desktop, join(checks, "unlock-typed.png"));
      await control(desktop, "composer.set_text", { text: "" });
      return await finish(true, { viewerKeyboardReachedComposer: true });
    }
    if (command === "reset") {
      await evalIn(browser, browserScript((origin) => { if (location.origin !== origin) location.href = `${origin}/`; return true; }, [WORKPLACE_ORIGIN]));
      await waitFor(browser, browserScript((origin) => location.origin === origin && document.readyState === "complete", [WORKPLACE_ORIGIN]), { timeoutMs: 60_000, label: "workplace page" });
      // The attendee's own page and cookie: the same POST the "Reset my sample data" button sends.
      const result = await evalIn(browser, async () => {
        const drafts = async () => ((await (await fetch("/_workshop/state/microsoft")).json()).messages ?? []).filter((message: { isDraft?: boolean }) => message.isDraft).length;
        const before = await drafts();
        const response = await fetch("/_workshop/reset", { method: "POST", redirect: "manual" });
        return { status: response.status, type: response.type, draftsBefore: before, draftsAfter: await drafts() };
      });
      const passed = record(result) && (result.status === 303 || result.type === "opaqueredirect");
      await foregroundWorkshopDesktop(browser, desktop);
      return await finish(passed, { result });
    }

    // Model-backed commands start from a fresh task on the workshop model.
    await foregroundWorkshopDesktop(browser, desktop);
    await freshComposer(desktop, modelId);
    const before = await verifyMember(member, orgId, memberId);
    if (command === "task") {
      await sendComposerMessage(desktop, "Using the connected workshop tools only (no shell), find the latest Northwind pilot email and tell me in under 80 words whether the pilot is production-ready and what is still pending. Do not change anything.");
      await waitForAssistantReply(desktop, { timeoutMs: 300_000 });
      await waitIdle(desktop, 300_000, "task finished");
      const reply = await waitForAssistantReply(desktop, { timeoutMs: 5_000 });
      const after = await verifyMember(member, orgId, memberId);
      const passed = /northwind/i.test(reply.text) && Number(after.usedMicroUsd) > Number(before.usedMicroUsd ?? 0);
      return await finish(passed, { reply: reply.text, usedMicroUsdBefore: before.usedMicroUsd, usedMicroUsdAfter: after.usedMicroUsd });
    }
    if (command === "steer") {
      const marker = `STEERED-${Date.now().toString(36).toUpperCase()}`;
      await sendComposerMessage(desktop, "Using the connected workshop tools only (no shell), review Northwind across Outlook, Jira and Confluence one service at a time, and write a detailed summary of each. Do not change anything.");
      await waitFor(desktop, browserScript((pattern) => [...document.querySelectorAll("button")]
        .some((button) => new RegExp(pattern, "i").test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()) && !button.disabled), [STOP.source]),
        { timeoutMs: 60_000, label: "task is running" });
      const usersBefore = await userMessages(desktop);
      await writeComposerText(desktop, `Change of plan: stop reviewing other services. Answer in one sentence and end with the exact word ${marker}.`);
      const steeredWhileBusy = await busy(desktop);
      await pressCtrlEnter(desktop);
      await waitFor(desktop, browserScript((count) => document.querySelectorAll('[data-message-role="user"]').length > count, [usersBefore]),
        { timeoutMs: 30_000, label: "steer message accepted mid-task" });
      await waitIdle(desktop, 300_000, "steered task finished");
      const reply = await waitForAssistantReply(desktop, { timeoutMs: 5_000 });
      const composer = await readComposerState(desktop);
      return await finish(steeredWhileBusy && reply.text.includes(marker), { marker, steeredWhileBusy, reply: reply.text, draftLeft: composer.draftText });
    }
    if (command === "stop") {
      await sendComposerMessage(desktop, "Using the connected workshop tools only (no shell), review every Northwind email, Jira issue and Confluence page in detail. Do not change anything.");
      await waitFor(desktop, browserScript((pattern) => [...document.querySelectorAll("button")]
        .some((button) => new RegExp(pattern, "i").test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()) && !button.disabled), [STOP.source]),
        { timeoutMs: 60_000, label: "task is running" });
      const stopAt = Date.now();
      await control(desktop, "composer.stop");
      await waitIdle(desktop, 60_000, "run stopped");
      const stoppedSeconds = Math.round((Date.now() - stopAt) / 1000);
      await freshComposer(desktop, modelId);
      const composer = await readComposerState(desktop);
      return await finish(composer.composerEditable && !composer.modelUnavailable, { stoppedSeconds, composerUsableAfterStop: composer.composerEditable });
    }
  } catch (error) {
    await finish(false, { error: error instanceof Error ? error.message.slice(0, 3000) : String(error) });
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
