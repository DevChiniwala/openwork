import { fileURLToPath } from "node:url";
import { createProcessLauncher } from "@openwork/child-process/client";
import { installProcessLauncher } from "@openwork/child-process";

/**
 * One already-signed Electron utility process, not a second engine executable.
 * Caller must await app readiness. Disabled launches retain the existing path.
 */
export function startDesktopLaunchBroker({ utilityProcess, enabled }) {
  if (!enabled) return null;
  const worker = utilityProcess.fork(fileURLToPath(new URL("./launch-broker-process.mjs", import.meta.url)), [], {
    serviceName: "OpenWork launch broker",
    stdio: "pipe",
  });
  // inherit stdio is unavailable on utilityProcess; keep legacy inherited output
  // draining. No request, argument, environment or pipe payload is logged here.
  worker.stdout?.pipe(process.stdout, { end: false });
  worker.stderr?.pipe(process.stderr, { end: false });
  const launcher = createProcessLauncher({
    send: value => worker.postMessage(value),
    subscribe: receive => worker.on("message", receive),
    onClose: receive => worker.once("exit", receive),
  });
  installProcessLauncher(launcher);
  return {
    pid: () => worker.pid,
    async stop() { await launcher.shutdown(); worker.kill(); },
  };
}
