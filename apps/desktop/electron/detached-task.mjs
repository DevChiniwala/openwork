import { fileURLToPath } from "node:url";

// Work that must outlive the app, such as deleting files the app held open,
// runs in a second copy of this binary started with this flag. Packaged builds
// turn off ELECTRON_RUN_AS_NODE, so the binary cannot run a script as plain
// Node; boot.mjs runs the task instead of loading the app.
const DETACHED_TASK_FLAG = "--openwork-detached-task=";
const BOOT_PATH = fileURLToPath(new URL("./boot.mjs", import.meta.url));

/** Arguments that start this binary as `task` rather than as the app. */
export function detachedTaskArgs(task, args, { isPackaged }) {
  // A packaged binary always loads boot.mjs from app.asar; an unpackaged
  // Electron is handed it.
  return [...(isPackaged ? [] : [BOOT_PATH]), `${DETACHED_TASK_FLAG}${task}`, ...args];
}

/** The task this process was started for, or null for a normal launch. */
export function readDetachedTask(argv) {
  const index = argv.findIndex((arg) => arg.startsWith(DETACHED_TASK_FLAG));
  if (index < 0) return null;
  return { name: argv[index].slice(DETACHED_TASK_FLAG.length), args: argv.slice(index + 1) };
}
