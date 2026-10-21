/** Support-only receipt checks. No provisioning, credentials, writes or implicit network calls. */
export const CONNECTORS = ["outlook", "calendar", "drive", "jira", "confluence"] as const;

export type Check = { ok: boolean; failures: string[] };
const result = (failures: string[]): Check => ({ ok: failures.length === 0, failures });
const exactSet = (actual: readonly string[], expected: readonly string[]) =>
  actual.length === expected.length && new Set(actual).size === actual.length && expected.every((item) => actual.includes(item));

export interface TemplateReceipt {
  snapshotId: string;
  sourceSha: string;
  state: string;
  capture: "cold" | "hot";
  /** A build from a clean allowlisted context, NOT a signed-in pilot with files deleted. */
  cleanBuild: boolean;
  softwareVerified: boolean;
  auditComplete: boolean;
  /** Names/categories only; never include values, paths containing tokens, or credentials. */
  residueCategories: readonly string[];
  endpointBinding: "before-first-launch" | "baked-or-resumed";
  includesBackend: boolean;
}

/** Attestations must be supplied by an independent audit; this is not a scrubber or scanner. */
export function checkTemplate(receipt: TemplateReceipt): Check {
  const failures: string[] = [];
  if (!receipt.snapshotId || !/^[a-f0-9]{40}$/.test(receipt.sourceSha)) failures.push("template: missing immutable provenance");
  if (receipt.state.toLowerCase() !== "active") failures.push("template: snapshot not active");
  if (receipt.capture !== "cold" || !receipt.cleanBuild) failures.push("template: require cold clean-build software image, not user-state capture");
  if (!receipt.softwareVerified || !receipt.auditComplete || receipt.residueCategories.length) failures.push("template: software/security audit incomplete or residue present");
  if (receipt.endpointBinding !== "before-first-launch") failures.push("template: runtime Den binding required before first launch");
  if (receipt.includesBackend) failures.push("template: Den/workplace backend must remain separate");
  return result(failures);
}

export interface Capacity {
  cpu: number;
  memoryGiB: number;
  storageGiB: number;
  sandboxes: number;
  activeSnapshots: number;
}

/** Inputs are remaining headroom AFTER all existing worlds/pilot/backend and safety reserve. */
export function checkCapacity(available: Capacity, perDesktop: Omit<Capacity, "activeSnapshots">, remaining = 19, newSnapshots = 1): Check {
  const failures: string[] = [];
  if (!Number.isInteger(remaining) || remaining < 0 || !Number.isInteger(newSnapshots) || newSnapshots < 0) return result(["capacity: invalid counts"]);
  for (const key of ["cpu", "memoryGiB", "storageGiB", "sandboxes"] as const) {
    if (!Number.isFinite(available[key]) || available[key] < 0 || !Number.isFinite(perDesktop[key]) || perDesktop[key] <= 0 || available[key] < perDesktop[key] * remaining) failures.push(`capacity: insufficient or invalid ${key}`);
  }
  if (!Number.isInteger(available.activeSnapshots) || available.activeSnapshots < newSnapshots) failures.push("capacity: insufficient active snapshot headroom");
  return result(failures);
}

export interface PilotReceipt {
  sandboxId: string;
  snapshotId: string;
  sourceSha: string;
  acceptedAt: number;
  freshProfileBeforeSignin: boolean;
  ordinaryMemberVerified: boolean;
  browserSigninAndReturn: boolean;
  restartRetainsOnlyOwnIdentity: boolean;
  modelInventoryReady: boolean;
  actualModelReply: boolean;
  connectedApps: readonly string[];
  exercisedApps: readonly string[];
  isolationAndResetVerified: boolean;
  readyComposerFocused: boolean;
}

/** Only a real completed UI path supplies these facts. Inventory/HTTP 200 is not sign-in. */
export function checkPilot(pilot: PilotReceipt, template: TemplateReceipt): Check {
  const failures: string[] = [];
  if (!pilot.sandboxId || pilot.snapshotId !== template.snapshotId || pilot.sourceSha !== template.sourceSha) failures.push("pilot: template provenance mismatch");
  if (!Number.isFinite(pilot.acceptedAt) || pilot.acceptedAt <= 0) failures.push("pilot: missing acceptance timestamp");
  for (const key of ["freshProfileBeforeSignin", "ordinaryMemberVerified", "browserSigninAndReturn", "restartRetainsOnlyOwnIdentity", "modelInventoryReady", "actualModelReply", "isolationAndResetVerified", "readyComposerFocused"] as const) {
    if (pilot[key] !== true) failures.push(`pilot: ${key} unverified`);
  }
  if (!exactSet(pilot.connectedApps, CONNECTORS) || !exactSet(pilot.exercisedApps, CONNECTORS)) failures.push("pilot: all five connector consents and exercises required");
  return result(failures);
}

export interface CloneReceipt {
  sandboxId: string;
  snapshotId: string;
  sourceSha: string;
  createdAt: number;
  profileIdentity: string;
  signedIn: boolean;
  softwareInventoryMatches: boolean;
  appReady: boolean;
  /** Exact URLs checked in memory; do NOT print signed hostnames or viewer URLs. */
  denApiUrl: string;
  denWebUrl: string;
  denApiHealthy: boolean;
  denWebReachable: boolean;
  workplaceReachable: boolean;
  tlsValidated: boolean;
  checkedAt: number;
  earliestPreviewExpiry: number;
  viewerProtection: "private" | "unique-bearer" | "public";
  viewerAccessTested: boolean;
}

/** Final 20-desktop audit, with only the pilot signed in. Missing/duplicate/stale evidence fails closed. */
export function checkFleet(input: {
  template: TemplateReceipt;
  pilot: PilotReceipt;
  clones: readonly CloneReceipt[];
  expectedSandboxIds: readonly string[];
  forbiddenSandboxIds: readonly string[];
  denApiUrl: string;
  denWebUrl: string;
  now: number;
  workshopEndsAt: number;
  maxEvidenceAgeMs?: number;
}): Check {
  const failures = [...checkTemplate(input.template).failures, ...checkPilot(input.pilot, input.template).failures];
  const ids = input.clones.map((clone) => clone.sandboxId);
  if (input.expectedSandboxIds.length !== 20 || !exactSet(ids, input.expectedSandboxIds) || !ids.includes(input.pilot.sandboxId)) failures.push("fleet: require exactly 20 distinct owned sandboxes including pilot");
  if (new Set(input.clones.map((clone) => clone.profileIdentity)).size !== input.clones.length || input.clones.some((clone) => !clone.profileIdentity)) failures.push("fleet: profile identities missing or shared");
  if (!Number.isFinite(input.now) || !Number.isFinite(input.workshopEndsAt) || input.workshopEndsAt <= input.now || input.pilot.acceptedAt > input.now) failures.push("fleet: invalid event/pilot time");
  for (const [index, clone] of input.clones.entries()) {
    const prefix = `desktop ${index + 1}`; // Never reflect identifiers or URLs into errors.
    if (input.forbiddenSandboxIds.includes(clone.sandboxId)) failures.push(`${prefix}: belongs to another world`);
    if (clone.snapshotId !== input.template.snapshotId || clone.sourceSha !== input.template.sourceSha) failures.push(`${prefix}: provenance mismatch`);
    if (clone.denApiUrl !== input.denApiUrl || clone.denWebUrl !== input.denWebUrl) failures.push(`${prefix}: Den endpoint mismatch`);
    if (clone.signedIn !== (clone.sandboxId === input.pilot.sandboxId)) failures.push(`${prefix}: only pilot may be signed in`);
    if (clone.sandboxId !== input.pilot.sandboxId && (!Number.isFinite(clone.createdAt) || clone.createdAt < input.pilot.acceptedAt || clone.createdAt > input.now)) failures.push(`${prefix}: allocated before pilot acceptance or invalid time`);
    for (const key of ["softwareInventoryMatches", "appReady", "denApiHealthy", "denWebReachable", "workplaceReachable", "tlsValidated", "viewerAccessTested"] as const) {
      if (clone[key] !== true) failures.push(`${prefix}: ${key} unverified`);
    }
    if (!Number.isFinite(clone.checkedAt) || clone.checkedAt > input.now || input.now - clone.checkedAt > (input.maxEvidenceAgeMs ?? 300_000)) failures.push(`${prefix}: evidence stale or missing`);
    if (!Number.isFinite(clone.earliestPreviewExpiry) || clone.earliestPreviewExpiry < input.workshopEndsAt + 600_000) failures.push(`${prefix}: preview expires before event plus reserve`);
    if (clone.viewerProtection !== "private" && clone.viewerProtection !== "unique-bearer") failures.push(`${prefix}: unprotected viewer`);
  }
  return result(failures);
}

/** Execute INSIDE each existing desktop; only unauthenticated GETs, no redirects/cookies. */
export async function probeDenReachability(apiUrl: string, webUrl: string, request: typeof fetch = fetch): Promise<Check> {
  const failures: string[] = [];
  for (const [label, value] of [["api", apiUrl], ["web", webUrl]]) {
    let url: URL;
    try {
      url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    } catch {
      failures.push(`Den ${label}: require exact HTTPS endpoint without query credentials`);
      continue;
    }
    const target = label === "api" ? `${url.href.replace(/\/+$/, "")}/health` : url.href;
    try {
      const response = await request(target, { method: "GET", redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(15_000), headers: { accept: label === "api" ? "application/json" : "text/html" } });
      if (response.status !== 200) { failures.push(`Den ${label}: expected HTTP 200 without redirect`); continue; }
      if (label === "api") {
        const body: unknown = await response.json();
        if (typeof body !== "object" || body === null || !("ok" in body) || body.ok !== true || !("service" in body) || body.service !== "den-api") failures.push("Den api: wrong health service (possible preview interstitial)");
      } else {
        const html = await response.text();
        if (!response.headers.get("content-type")?.includes("text/html") || /preview warning|visit site|daytona.*warning/i.test(html) || !/openwork/i.test(html)) failures.push("Den web: expected OpenWork HTML, not preview interstitial");
      }
    } catch { failures.push(`Den ${label}: TLS/transport/body check failed`); }
  }
  return result(failures);
}
