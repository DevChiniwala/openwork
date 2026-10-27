import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { runPendingNukeCleanup } from "./nuke.mjs";

const WORKER_RETRY_INTERVAL_MS = 500;
const RELAUNCH_HANDLE_GRACE_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function isAbsoluteForPlatform(value, platform) {
  return pathApi(platform).isAbsolute(String(value ?? ""));
}

function parentIsAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function validateNukeWorkerPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid nuke worker payload.");
  }
  const payload = value;
  const nukeInput = payload.nukeInput;
  if (!nukeInput || typeof nukeInput !== "object" || Array.isArray(nukeInput)) {
    throw new Error("Invalid nuke worker nukeInput.");
  }
  const platform = nukeInput.platform === "win32" || nukeInput.platform === "darwin" || nukeInput.platform === "linux"
    ? nukeInput.platform
    : "linux";
  const homedir = typeof nukeInput.homedir === "string" ? nukeInput.homedir : "";
  const userDataPath = typeof nukeInput.userDataPath === "string" ? nukeInput.userDataPath : "";
  if (!isAbsoluteForPlatform(homedir, platform) || !isAbsoluteForPlatform(userDataPath, platform)) {
    throw new Error("Nuke worker paths must be absolute.");
  }
  const appArgv = Array.isArray(payload.appArgv) ? payload.appArgv.filter((arg) => typeof arg === "string") : [];
  const parentPid = Number(payload.parentPid) || 0;
  const now = Date.now();
  const parentWaitDeadlineAt = Number.isFinite(payload.parentWaitDeadlineAt) ? Number(payload.parentWaitDeadlineAt) : now;
  const deadlineAt = Number.isFinite(payload.deadlineAt) ? Number(payload.deadlineAt) : now;
  return {
    version: 1,
    parentPid,
    nukeInput: {
      env: nukeInput.env && typeof nukeInput.env === "object" && !Array.isArray(nukeInput.env) ? nukeInput.env : {},
      homedir,
      platform,
      preserveBootstrap: nukeInput.preserveBootstrap !== false,
      userDataPath,
      workspacePaths: Array.isArray(nukeInput.workspacePaths)
        ? nukeInput.workspacePaths.filter((entry) => typeof entry === "string" && entry.trim())
        : [],
    },
    appArgv,
    pendingPath: typeof payload.pendingPath === "string" ? payload.pendingPath : "",
    parentWaitDeadlineAt,
    deadlineAt,
  };
}

async function waitForParentExit(parentPid, deadlineAt, deps) {
  const sleepFn = deps.sleep ?? sleep;
  while (Date.now() < deadlineAt && parentIsAlive(parentPid)) {
    await sleepFn(WORKER_RETRY_INTERVAL_MS);
  }
}

async function cleanupUntilDeadline(payload, deps) {
  const sleepFn = deps.sleep ?? sleep;
  const runPendingCleanup = deps.runPendingCleanup ?? runPendingNukeCleanup;
  let result = await runPendingCleanup(payload.nukeInput);
  while (result.pendingRetry.length > 0 && Date.now() < payload.deadlineAt) {
    await sleepFn(WORKER_RETRY_INTERVAL_MS);
    result = await runPendingCleanup(payload.nukeInput);
  }
  return result;
}

function boundedMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

async function waitForHandleReleaseGrace(deps) {
  const sleepFn = deps.sleep ?? sleep;
  const graceMs = boundedMs(deps.relaunchHandleGraceMs, RELAUNCH_HANDLE_GRACE_MS);
  if (graceMs > 0) await sleepFn(graceMs);
}

// The worker runs as the app's own binary (a detached task, see boot.mjs), so
// it relaunches that binary rather than any path named in the payload.
function launchApp(payload, deps) {
  const spawnApp = deps.spawnApp ?? spawn;
  const env = { ...(deps.env ?? process.env) };
  delete env["OPENWORK_ELECTRON_REMOTE_DEBUG_PORT"];
  const child = spawnApp(deps.appExecutablePath ?? process.execPath, payload.appArgv, {
    detached: true,
    env,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref?.();
  return child.pid ?? null;
}

export async function runNukeCleanupWorker(payloadPath, deps = {}) {
  const raw = JSON.parse(await readFile(payloadPath, "utf8"));
  const payload = validateNukeWorkerPayload(raw);
  await waitForParentExit(payload.parentPid, payload.parentWaitDeadlineAt, deps);
  let cleanup = null;
  try {
    cleanup = await cleanupUntilDeadline(payload, deps);
  } catch (error) {
    cleanup = {
      ran: false,
      invalid: false,
      deleted: [],
      pendingRetry: [],
      errors: [{ path: "nuke-cleanup-worker", message: errorMessage(error) }],
    };
  }
  await waitForHandleReleaseGrace(deps);
  await rm(payloadPath, { force: true }).catch(() => undefined);
  const launchPid = launchApp(payload, deps);
  return { cleanup, launchPid };
}
