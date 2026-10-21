import assert from "node:assert/strict";
import test from "node:test";
import { checkCapacity, checkFleet, checkPilot, checkTemplate, CONNECTORS, probeDenReachability } from "./workshop-template-check.ts";
import type { CloneReceipt, PilotReceipt, TemplateReceipt } from "./workshop-template-check.ts";

const now = 1_000_000;
const template: TemplateReceipt = { snapshotId: "software-only", sourceSha: "a".repeat(40), state: "active", capture: "cold", cleanBuild: true, softwareVerified: true, auditComplete: true, residueCategories: [], endpointBinding: "before-first-launch", includesBackend: false };
const pilot: PilotReceipt = { sandboxId: "desktop-0", snapshotId: template.snapshotId, sourceSha: template.sourceSha, acceptedAt: now - 1000, freshProfileBeforeSignin: true, ordinaryMemberVerified: true, browserSigninAndReturn: true, restartRetainsOnlyOwnIdentity: true, modelInventoryReady: true, actualModelReply: true, connectedApps: [...CONNECTORS], exercisedApps: [...CONNECTORS], isolationAndResetVerified: true, readyComposerFocused: true };
const clones = (): CloneReceipt[] => Array.from({ length: 20 }, (_, index) => ({ sandboxId: `desktop-${index}`, snapshotId: template.snapshotId, sourceSha: template.sourceSha, createdAt: now - (index === 0 ? 2000 : 500), profileIdentity: `fresh-profile-${index}`, signedIn: index === 0, softwareInventoryMatches: true, appReady: true, denApiUrl: "https://api.example.test", denWebUrl: "https://web.example.test", denApiHealthy: true, denWebReachable: true, workplaceReachable: true, tlsValidated: true, checkedAt: now, earliestPreviewExpiry: now + 4_000_000, viewerProtection: "private", viewerAccessTested: true }));
const fleet = () => ({ template, pilot, clones: clones(), expectedSandboxIds: clones().map((clone) => clone.sandboxId), forbiddenSandboxIds: ["other-world"], denApiUrl: "https://api.example.test", denWebUrl: "https://web.example.test", now, workshopEndsAt: now + 3_000_000 });

test("clean software receipt passes; authenticated/hot/resumed captures do not", () => {
  assert.equal(checkTemplate(template).ok, true);
  assert.equal(checkTemplate({ ...template, capture: "hot" }).ok, false);
  assert.equal(checkTemplate({ ...template, cleanBuild: false }).ok, false);
  assert.equal(checkTemplate({ ...template, endpointBinding: "baked-or-resumed" }).ok, false);
  assert.equal(checkTemplate({ ...template, residueCategories: ["browser-identity"] }).ok, false);
  assert.equal(checkTemplate({ ...template, includesBackend: true }).ok, false);
});

test("capacity accounts for 19 additional desktops plus template slot", () => {
  const remaining = { cpu: 38, memoryGiB: 76, storageGiB: 190, sandboxes: 19, activeSnapshots: 1 };
  const desktop = { cpu: 2, memoryGiB: 4, storageGiB: 10, sandboxes: 1 };
  assert.equal(checkCapacity(remaining, desktop).ok, true);
  for (const key of Object.keys(remaining)) {
    assert.equal(checkCapacity({ ...remaining, [key]: 0 }, desktop).ok, false);
  }
  assert.equal(checkCapacity(remaining, { ...desktop, cpu: Number.NaN }).ok, false);
});

test("inventory alone cannot satisfy pilot", () => {
  assert.equal(checkPilot(pilot, template).ok, true);
  assert.equal(checkPilot({ ...pilot, browserSigninAndReturn: false }, template).ok, false);
  assert.equal(checkPilot({ ...pilot, actualModelReply: false }, template).ok, false);
  assert.equal(checkPilot({ ...pilot, connectedApps: ["outlook"] }, template).ok, false);
  assert.equal(checkPilot({ ...pilot, exercisedApps: [...CONNECTORS, "outlook"] }, template).ok, false);
});

test("exactly 20 unique, isolated desktops; only pilot signed in", () => {
  assert.equal(checkFleet(fleet()).ok, true);
  assert.equal(checkFleet({ ...fleet(), clones: clones().slice(0, 19) }).ok, false);
  const duplicate = clones();
  duplicate[1] = duplicate[0];
  assert.equal(checkFleet({ ...fleet(), clones: duplicate }).ok, false);
});

test("each clone must independently meet every readiness/security gate", () => {
  const variants: Partial<CloneReceipt>[] = [
    { signedIn: true }, { createdAt: pilot.acceptedAt - 1 }, { denApiUrl: "https://wrong.example.test" },
    { viewerProtection: "public" }, { viewerAccessTested: false }, { checkedAt: 1 },
    { earliestPreviewExpiry: now + 1 }, { tlsValidated: false }, { workplaceReachable: false },
    { softwareInventoryMatches: false }, { denApiHealthy: false }, { profileIdentity: "fresh-profile-0" },
    { sandboxId: "other-world" }, { snapshotId: "wrong" },
  ];
  for (const variant of variants) {
    const input = fleet();
    input.clones[1] = { ...input.clones[1], ...variant };
    assert.equal(checkFleet(input).ok, false, JSON.stringify(variant));
  }
});

test("Den probe is GET-only, suppresses credentials, and validates service", async () => {
  const calls: string[] = [];
  const request: typeof fetch = async (url, options) => {
    calls.push(String(url));
    assert.equal(options?.method, "GET");
    assert.equal(options?.credentials, "omit");
    assert.equal(options?.redirect, "manual");
    return String(url).endsWith("/health")
      ? Response.json({ ok: true, service: "den-api" })
      : new Response("<html>OpenWork</html>", { headers: { "content-type": "text/html" } });
  };
  assert.equal((await probeDenReachability("https://api.example.test", "https://web.example.test", request)).ok, true);
  assert.deepEqual(calls, ["https://api.example.test/health", "https://web.example.test/"]);
  assert.equal((await probeDenReachability("http://unsafe.test", "https://web.example.test/?token=private", request)).ok, false);
  assert.equal(calls.length, 2);
});

test("Den probe rejects preview HTML, redirects, transport and wrong JSON without leaking URLs", async () => {
  const requests: (typeof fetch)[] = [
    async () => new Response("Visit site", { headers: { "content-type": "text/html" } }),
    async () => new Response(null, { status: 302 }),
    async () => Response.json({ ok: true, service: "wrong" }),
    async () => { throw new Error("private-hostname-do-not-log"); },
  ];
  for (const request of requests) {
    const checked = await probeDenReachability("https://api.example.test", "https://web.example.test", request);
    assert.equal(checked.ok, false);
    assert.equal(JSON.stringify(checked).includes("private-hostname-do-not-log"), false);
  }
});
