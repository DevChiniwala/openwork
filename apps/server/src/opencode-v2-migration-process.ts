// Runs one chat history migration in an Electron utility process; see runOpencodeV1HistoryMigration.
import { migrateOpencodeV1History, type MigrationProcessMessage, type MigrationProcessRequest } from "./opencode-v2-migration.js";

interface ParentPort {
  once(event: "message", listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: MigrationProcessMessage): void;
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
if (!parentPort) throw new Error("The chat migration worker must run as an Electron utility process.");

function isRequest(value: unknown): value is MigrationProcessRequest {
  return typeof value === "object" && value !== null && "source" in value && "targetDatabase" in value;
}

let converterPid: number | undefined;
function stopConverter() {
  if (converterPid) {
    try { process.kill(converterPid); } catch { /* already gone */ }
  }
}
// OpenWork stopped this migration, quit or crashed: stop rather than keep
// copying unseen. The next migration resumes the durable workspace this leaves
// behind.
process.once("SIGTERM", () => {
  stopConverter();
  process.exit(1);
});
const openworkPid = process.ppid;
setInterval(() => {
  try { process.kill(openworkPid, 0); } catch {
    stopConverter();
    process.exit(1);
  }
}, 1000).unref();

parentPort.once("message", async ({ data: message }) => {
  if (!isRequest(message)) throw new Error("Invalid migration request");
  await migrateOpencodeV1History({
    ...message,
    progress: (status) => { parentPort.postMessage({ type: "progress", status }); },
    scratch: (scratch) => {
      converterPid = scratch.converterPid;
      parentPort.postMessage({ type: "scratch", scratch });
    },
  });
  // The migration has cleaned up; the supervisor ends this process once this arrives.
  converterPid = undefined;
  parentPort.postMessage({ type: "done" });
});
