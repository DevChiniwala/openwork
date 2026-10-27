import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

// Linux smoke commands include xvfb -> pnpm -> Vitest -> Electron. A timeout
// must terminate the process group, not just the outer launcher.
export function runCommand(command, args, { timeout, ...options }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, detached: true });
    let timedOut = false;
    const killGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      killGroup();
      resolve({ status, signal, timedOut });
    });
  });
}

// The fuse wire @electron/fuses writes: this sentinel, a version byte, a length
// byte, then one byte per fuse ("0" off, "1" on, "r" removed).
const FUSE_SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
const FUSES = ["RunAsNode", "EnableCookieEncryption", "EnableNodeOptionsEnvironmentVariable",
  "EnableNodeCliInspectArguments", "EnableEmbeddedAsarIntegrityValidation", "OnlyLoadAppFromAsar"];

/** The packaged binary's fuses that electron-builder.base.yml sets, by name. */
function readElectronFuses(binary) {
  const bytes = readFileSync(binary);
  const at = bytes.indexOf(FUSE_SENTINEL);
  if (at < 0) throw new Error(`No Electron fuse wire in ${binary}`);
  const wire = bytes.subarray(at + FUSE_SENTINEL.length + 2);
  return Object.fromEntries(FUSES.map((name, index) => [name, String.fromCharCode(wire[index])]));
}

/** Throws unless the packaged binary refuses to run anything but its own app.asar. */
export function assertHardenedFuses(binary) {
  const fuses = readElectronFuses(binary);
  const expected = { RunAsNode: "0", EnableNodeOptionsEnvironmentVariable: "0", EnableNodeCliInspectArguments: "0",
    EnableEmbeddedAsarIntegrityValidation: "1", OnlyLoadAppFromAsar: "1" };
  const wrong = Object.entries(expected).filter(([name, value]) => fuses[name] !== value);
  if (wrong.length) throw new Error(`Packaged Electron fuses are not hardened: ${wrong.map(([name]) => `${name}=${fuses[name]}`).join(", ")}`);
  return fuses;
}
