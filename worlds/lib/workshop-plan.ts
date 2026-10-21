/**
 * Pure planning helpers for the `workshop` world: argument parsing, attendee
 * identities, ordered preflight, desktop allocation and output shaping. Nothing
 * here touches Den, Daytona or the network, so it is unit-testable as-is.
 */
import { output, secret } from "../../packages/world/src/outputs.ts";
import type { WorldOutput } from "../../packages/world/src/outputs.ts";

/** The five Open Workplace connectors, exactly as evals/worlds/workshop-oauth.ts adds them. */
export const WORKSHOP_APPS = ["outlook", "calendar", "drive", "jira", "confluence"] as const;
export type WorkshopApp = (typeof WORKSHOP_APPS)[number];
/** Same default as evals/worlds/workshop-agent.ts; override with `--model`. */
export const WORKSHOP_DEFAULT_MODEL = "gpt-6.1-sol";
/**
 * Den, AI Gateway and workplace preview links on Daytona are signed for 24 hours
 * (`daytona preview-url --expires 86400`), so a remote world must end before they do.
 */
export const DAYTONA_MAX_LIFETIME_MINUTES = 1380;

export interface WorkshopOptions {
  /** Attendee desktops; 0 boots the backend only. */
  count: number;
  /** Minutes until the world stops itself; 0 keeps it running (local only). */
  lifetimeMinutes: number;
  /** Daily per-member AI Gateway allowance in USD when a model key is present. */
  allowanceUsd: string;
  model: string;
  /** Desktops allocated at once after the pilot. */
  concurrency: number;
}

const USAGE = "Use -- --count <attendees, 0 = backend only> [--lifetime <minutes>] [--allowance-usd <decimal>] [--model <id>] [--concurrency <1-4>].";

export function parseWorkshopArgs(argv: readonly string[], place: "local" | "daytona"): WorkshopOptions {
  const options: WorkshopOptions = { count: 0, lifetimeMinutes: 720, allowanceUsd: "5", model: WORKSHOP_DEFAULT_MODEL, concurrency: 2 };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || seen.has(flag)) throw new Error(USAGE);
    seen.add(flag);
    if (flag === "--count" && /^\d{1,4}$/.test(value)) options.count = Number(value);
    else if (flag === "--lifetime" && /^\d{1,4}$/.test(value)) options.lifetimeMinutes = Number(value);
    else if (flag === "--allowance-usd" && /^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(value)) options.allowanceUsd = value;
    else if (flag === "--model" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) options.model = value;
    else if (flag === "--concurrency" && /^[1-4]$/.test(value)) options.concurrency = Number(value);
    else throw new Error(USAGE);
  }
  if (place === "daytona" && (options.lifetimeMinutes < 1 || options.lifetimeMinutes > DAYTONA_MAX_LIFETIME_MINUTES)) {
    throw new Error(`On Daytona use --lifetime 1-${DAYTONA_MAX_LIFETIME_MINUTES}: the Den and workplace preview links are signed for 24 hours.`);
  }
  if (options.lifetimeMinutes > 1440) throw new Error("Use --lifetime 0-1440 (0 keeps a local world running until stopped).");
  return options;
}

/** Stable member keys: attendee-01 … attendee-NN, zero-padded so no key prefixes another. */
export function attendeeKeys(count: number): string[] {
  const width = Math.max(2, String(count).length);
  return Array.from({ length: count }, (_, index) => `attendee-${String(index + 1).padStart(width, "0")}`);
}

export function attendeeName(key: string): string {
  return `Attendee ${key.slice("attendee-".length)}`;
}

/** Replace every known secret (and its URL-encoded form) before text reaches a log, an error or an output. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let result = text;
  for (const value of secrets) {
    if (!value || value.length < 6) continue;
    for (const form of new Set([value, encodeURIComponent(value), Buffer.from(value, "utf8").toString("base64")])) {
      result = result.split(form).join("[redacted]");
    }
  }
  return result;
}

export interface PreflightStep {
  id: string;
  label: string;
  run(): Promise<string | void>;
}

export class PreflightError extends Error {
  readonly step: string;
  constructor(step: string, message: string) {
    super(message);
    this.step = step;
    this.name = "PreflightError";
  }
}

/**
 * Runs checks in order and stops at the first failure, so no desktop is ever
 * allocated against a broken backend. Failure text is redacted.
 */
export async function runPreflight(
  steps: readonly PreflightStep[],
  options: { secrets?: readonly (string | undefined)[]; log?: (line: string) => void } = {},
): Promise<{ id: string; detail: string }[]> {
  const log = options.log ?? ((line: string) => console.error(line));
  const passed: { id: string; detail: string }[] = [];
  for (const step of steps) {
    try {
      const detail = (await step.run()) ?? "ok";
      passed.push({ id: step.id, detail });
      log(`preflight  ✓ ${step.label}${detail === "ok" ? "" : ` (${redact(detail, options.secrets ?? [])})`}`);
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error), options.secrets ?? []);
      log(`preflight  ✗ ${step.label}: ${message}`);
      throw new PreflightError(step.id, `Workshop preflight failed at "${step.label}": ${message}. No attendee desktops were allocated.`);
    }
  }
  return passed;
}

export type DesktopResult<T> = { key: string; ok: true; value: T } | { key: string; ok: false; error: string };

/**
 * One pilot desktop first (its failure aborts the world: every other desktop
 * would fail the same way), then the rest with bounded concurrency. Each
 * non-pilot desktop gets one retry; a desktop that still fails is reported
 * instead of tearing down the attendees that already work.
 */
export async function allocateDesktops<T>(
  keys: readonly string[],
  launch: (key: string, attempt: number) => Promise<T>,
  options: { concurrency: number; secrets?: readonly (string | undefined)[]; log?: (line: string) => void },
): Promise<DesktopResult<T>[]> {
  const log = options.log ?? ((line: string) => console.error(line));
  const message = (error: unknown) => redact(error instanceof Error ? error.message : String(error), options.secrets ?? []);
  const [pilot, ...rest] = keys;
  if (pilot === undefined) return [];
  let pilotValue: T;
  try {
    log(`desktops  pilot ${pilot}`);
    pilotValue = await launch(pilot, 1);
  } catch (error) {
    throw new Error(`Pilot desktop ${pilot} failed, so no other desktops were started: ${message(error)}`);
  }
  const results: DesktopResult<T>[] = [{ key: pilot, ok: true, value: pilotValue }];
  const queue = [...rest];
  const worker = async () => {
    for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
      let last = "";
      let value: T | undefined;
      let ok = false;
      for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        try {
          log(`desktops  ${key} attempt ${attempt}`);
          value = await launch(key, attempt);
          ok = true;
        } catch (error) {
          last = message(error);
          log(`desktops  ${key} attempt ${attempt} failed: ${last}`);
        }
      }
      results.push(ok ? { key, ok: true, value: value as T } : { key, ok: false, error: last });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, rest.length)) }, worker));
  return results.sort((a, b) => a.key.localeCompare(b.key));
}

/** The facilitator reset, run from this checkout; the reset key is read from the world's outputs, never typed or printed. */
export function resetCommand(stage: string | undefined): string {
  return `node worlds/lib/workshop-reset.ts${stage ? ` --stage ${stage}` : ""} --confirm`;
}

export interface WorkshopOutputInput {
  place: "local" | "daytona";
  stage: string | undefined;
  denWebUrl: string;
  denApiUrl: string;
  aiGatewayUrl?: string;
  workplaceUrl: string;
  resetToken: string;
  admin: { email: string; password: string };
  orgName: string;
  connections: readonly { app: string; id: string }[];
  model: { state: "provisioned" | "skipped" | "failed"; note: string };
  attendees: readonly ({ key: string; email: string; password: string } & ({ ok: true; viewerUrl?: string; sandbox?: string } | { ok: false; error: string }))[];
  denSandbox?: string;
  expires?: Date;
}

/** Outputs: links people need are plain, every credential and viewer link is a secret. */
export function workshopOutputs(input: WorkshopOutputInput): Record<string, WorldOutput> {
  const outputs: Record<string, WorldOutput> = {
    denWeb: output(input.denWebUrl, { group: "Workshop", note: "Den web; the host signs in here" }),
    workplace: output(input.workplaceUrl, { group: "Workshop", note: "Open Workplace; each browser joins its own private workspace automatically" }),
    reset: output(resetCommand(input.stage), { group: "Workshop", note: "Resets every attendee's fictional Outlook/Calendar/Drive/Jira/Confluence data; desktops, accounts and OAuth grants stay. Omit --confirm to preview." }),
    attendeeReset: output(`${input.workplaceUrl}/_workshop/reset`, { group: "Workshop", note: "Per attendee: open in that attendee's browser to reset only their data" }),
    adminEmail: output(input.admin.email, { group: "Host account", note: `Owner of ${input.orgName}` }),
    adminPassword: secret(input.admin.password, { group: "Host account" }),
    resetToken: secret(input.resetToken, { group: "Host account", note: "Facilitator reset key; read by the reset command" }),
    denApi: output(input.denApiUrl, { group: "Services" }),
    ...(input.aiGatewayUrl ? { aiGateway: output(input.aiGatewayUrl, { group: "Services" }) } : {}),
    connections: output(input.connections.map((connection) => connection.app).join(", "), { group: "Services", note: "Org-wide OAuth connections, one private grant per member" }),
    model: output(input.model.state, { group: "Services", note: input.model.note }),
    attendees: output(String(input.attendees.length), { group: "Attendees", note: input.attendees.some((attendee) => !attendee.ok) ? `${input.attendees.filter((attendee) => !attendee.ok).length} desktop(s) failed; see attendee entries` : "Each desktop is signed in as its own ordinary member" }),
  };
  for (const attendee of input.attendees) {
    const group = `Attendee ${attendee.key.slice("attendee-".length)}`;
    const id = attendee.key.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
    outputs[`${id}Email`] = output(attendee.email, { group });
    outputs[`${id}Password`] = secret(attendee.password, { group });
    if (attendee.ok) {
      if (attendee.viewerUrl) outputs[`${id}Viewer`] = secret(attendee.viewerUrl, { group, note: "noVNC desktop viewer; anyone with this link controls the desktop" });
      else if (input.place === "local") outputs[`${id}Viewer`] = output("OpenWork desktop window on this machine", { group });
      if (attendee.sandbox) outputs[`${id}Sandbox`] = output(attendee.sandbox, { group });
    } else {
      outputs[`${id}Status`] = output("failed", { group, note: attendee.error.slice(0, 300) });
    }
  }
  if (input.denSandbox) outputs.denSandbox = output(input.denSandbox, { group: "World" });
  outputs.placement = output(input.place, { group: "World" });
  outputs.expires = output(input.expires?.toISOString() ?? "Until stopped", { group: "World", note: "pnpm world down deletes the Den, workplace data and every desktop" });
  return outputs;
}
