#!/usr/bin/env node
/**
 * Facilitator reset for a running `workshop` world: every attendee's fictional
 * Outlook, Calendar, Drive, Jira and Confluence data returns to the seed.
 * Desktops, Den accounts, browser identities and OAuth grants are kept.
 *
 *   node worlds/lib/workshop-reset.ts --stage <event>            # preview, changes nothing
 *   node worlds/lib/workshop-reset.ts --stage <event> --confirm  # reset
 *
 * The reset key is read from the world's own outputs and handed to the existing
 * gateway reset client in memory; it never appears on a command line or in logs.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseResetOptions, resetWorkshop } from "../../evals/packages/open-workplace/src/workshop-reset.mjs";

export function parseArgs(argv: readonly string[]): { stage?: string; confirm: boolean } {
  let stage: string | undefined;
  let confirm = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--stage" && stage === undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(argv[index + 1] ?? "")) stage = argv[++index];
    else if (argv[index] === "--confirm" && !confirm) confirm = true;
    else throw new Error("Usage: node worlds/lib/workshop-reset.ts [--stage <event>] [--confirm]");
  }
  return { ...(stage ? { stage } : {}), confirm };
}

/** Reads `workplace` and `resetToken` from `pnpm world outputs workshop --reveal --json` output. */
export function readWorldOutputs(stdout: string): { origin: string; token: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? ""); } catch { throw new Error("Could not read the workshop world's outputs."); }
  const outputs = typeof parsed === "object" && parsed !== null && "outputs" in parsed ? (parsed as { outputs: Record<string, { value?: unknown }> }).outputs : undefined;
  if (typeof parsed === "object" && parsed !== null && "exists" in parsed && parsed.exists === false) throw new Error("No running workshop world for that stage. Check `pnpm world list`.");
  const origin = outputs?.workplace?.value;
  const token = outputs?.resetToken?.value;
  if (typeof origin !== "string" || typeof token !== "string" || token.includes("•")) throw new Error("The workshop world's outputs have no workplace URL or reset key.");
  return { origin, token };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const { stdout } = await promisify(execFile)("node", ["evals/bin/world.mjs", "outputs", "workshop", ...(args.stage ? ["--stage", args.stage] : []), "--reveal", "--json"], { cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
    .catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
  const { origin, token } = readWorldOutputs(stdout);
  const options = parseResetOptions(["--url", origin, "--all", ...(args.confirm ? ["--confirm"] : [])]);
  const receipt = await resetWorkshop(options, { token });
  console.log(receipt.message);
}

if (import.meta.main) {
  try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
