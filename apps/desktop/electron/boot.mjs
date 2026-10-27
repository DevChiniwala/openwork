import { app } from "electron";

import { readDetachedTask } from "./detached-task.mjs";

// Electron evaluates this entry, including its top-level await, before
// Chromium starts. A detached task therefore finishes without a window, Dock
// icon or profile of its own, and main.mjs loads only for a normal launch.
const task = readDetachedTask(process.argv);
if (!task) {
  await import("./main.mjs");
} else {
  app.dock?.hide();
  let exitCode = 2;
  try {
    if (task.name === "nuke-cleanup") {
      const { runNukeCleanupWorker } = await import("./nuke-worker.mjs");
      await runNukeCleanupWorker(task.args[0] ?? "");
      exitCode = 0;
    } else if (task.name === "blank-slate-cleanup") {
      const { removeBlankSlateProfileAfterExit } = await import("./blank-slate-cleanup.mjs");
      exitCode = await removeBlankSlateProfileAfterExit(task.args[0], task.args[1]);
    }
  } catch {
    exitCode = 1;
  }
  app.exit(exitCode);
}
