import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { BLANK_SLATE_ROOT_PREFIX } from "./blank-slate-profile.mjs";

function parentIsRunning(parentPid) {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch {
    return false;
  }
}

// Anyone can start the app binary with these arguments, so only a per-launch
// test profile root directly under the temporary directory is ever removed.
function isBlankSlateProfileRoot(rootPath, temporaryDirectory = tmpdir()) {
  if (typeof rootPath !== "string" || !rootPath) return false;
  const resolved = path.resolve(rootPath);
  return path.dirname(resolved) === path.resolve(temporaryDirectory)
    && path.basename(resolved).startsWith(BLANK_SLATE_ROOT_PREFIX);
}

/** Waits for the test-profile launch to exit, then removes its profile root. Returns an exit code. */
export async function removeBlankSlateProfileAfterExit(parentPidArg, rootPath) {
  const parentPid = Number.parseInt(parentPidArg ?? "", 10);
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || !isBlankSlateProfileRoot(rootPath)) return 1;
  let attempts = 0;
  while (parentIsRunning(parentPid) && attempts < 600) {
    attempts += 1;
    await setTimeout(100);
  }
  if (parentIsRunning(parentPid)) return 0;
  return rm(rootPath, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  }).then(() => 0, () => 1);
}
