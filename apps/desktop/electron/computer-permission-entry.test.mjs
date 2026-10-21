import assert from "node:assert/strict";
import test from "node:test";
import { resolvePermissionEntry } from "./computer-permission-entry.mjs";

/** Fake ps and plutil: `processes` maps pid to [parent, command]; `plists` maps an app bundle to its Info.plist values. */
function fakeExec(processes, plists) {
  return async (command, args) => {
    if (command === "/bin/ps") {
      const entry = processes[args.at(-1)];
      return { stdout: entry ? `${entry[0]} ${entry[1]}\n` : "" };
    }
    const [, key, , , , file] = args;
    const value = plists[file.slice(0, file.indexOf("/Contents/Info.plist"))]?.[key];
    if (value === undefined) throw new Error("No such key.");
    return { stdout: `${value}\n` };
  };
}

test("a packaged app that ps lists without its path still names its own bundle", async () => {
  const entry = await resolvePermissionEntry({
    pid: 4100,
    execPath: "/Applications/OpenWork.app/Contents/MacOS/OpenWork",
    exec: fakeExec({ 4100: [1, "OpenWork"] }, {
      "/Applications/OpenWork.app": { CFBundleName: "OpenWork", CFBundleIdentifier: "com.differentai.openwork" },
    }),
  });
  assert.deepEqual(entry, { name: "OpenWork", bundleId: "com.differentai.openwork", ours: true });
});

test("a development build names the terminal that started it, which is not ours to reset", async () => {
  const electron = "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
  const entry = await resolvePermissionEntry({
    pid: 4200,
    execPath: electron,
    exec: fakeExec({
      4200: [4199, electron],
      4199: [4198, "node"],
      4198: [4100, "-zsh"],
      4100: [1, "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"],
    }, {
      "/repo/node_modules/electron/dist/Electron.app": { CFBundleName: "Electron", CFBundleIdentifier: "com.github.Electron" },
      "/System/Applications/Utilities/Terminal.app": { CFBundleDisplayName: "Terminal", CFBundleIdentifier: "com.apple.Terminal" },
    }),
  });
  assert.deepEqual(entry, { name: "Terminal", bundleId: "com.apple.Terminal", ours: false });
});
