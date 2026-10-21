import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Workshop desktops sign real attendee accounts in and hold their Den access
 * and model allowance. Only code that has already been reviewed and merged may
 * receive that: an arbitrary PR commit could capture the sign-in grant. There
 * is deliberately no override; test unmerged code with the normal preview worlds.
 */
export async function assertTrustedWorkshopRef(ref: string, repoRoot: string, trustedBranch = "dev"): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error("Workshop source must be a full commit SHA.");
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(trustedBranch) || trustedBranch.startsWith("-")) throw new Error("Invalid trusted branch name.");
  try {
    await run("git", ["fetch", "--quiet", "origin", trustedBranch], { cwd: repoRoot, timeout: 120_000 });
  } catch {
    throw new Error(`Could not refresh origin/${trustedBranch}; refusing to sign attendees into unverified source.`);
  }
  try {
    await run("git", ["merge-base", "--is-ancestor", ref, `origin/${trustedBranch}`], { cwd: repoRoot, timeout: 60_000 });
  } catch {
    throw new Error(`Workshop source ${ref.slice(0, 12)} is not merged into origin/${trustedBranch}. Attendees are only signed in to reviewed, merged code; use a commit from ${trustedBranch}.`);
  }
}
