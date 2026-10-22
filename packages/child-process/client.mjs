import { ChildProcess } from "node:child_process";
import { Duplex } from "node:stream";

/**
 * Private, parent-created channel only. Never exposed to renderer IPC or HTTP.
 * No automatic replay: an unknown spawn outcome must not create two engines.
 */
export function createProcessLauncher(transport) {
  let sequence = 0;
  let failed = false;
  let stopped;
  const children = new Map();
  function request(message) {
    if (failed) throw new Error("Desktop launch broker unavailable; restart OpenWork to retry");
    transport.send(message);
  }
  function launch(type, command, args = [], options = {}, callback) {
    if (options.signal?.aborted) options.signal.throwIfAborted();
    const id = ++sequence;
    // Constructing ChildProcess does not call its native spawn method.
    const child = new ChildProcess();
    const pendingWrites = new Map();
    // execFile owns an error listener even when its caller only uses callback.
    if (callback) child.on("error", () => undefined);
    Object.assign(child, { pid: undefined, exitCode: null, signalCode: null, killed: false, connected: false });
    // Drop the uncloneable AbortSignal; cancellation travels over this channel.
    const { signal, ...explicit } = options;
    // Native defaults belong to the caller, not the broker's earlier snapshot.
    const serializable = { ...explicit, env: options.env ?? { ...process.env }, cwd: options.cwd ?? process.cwd() };
    const stdio = options.stdio ?? ["pipe", "pipe", "pipe"];
    const descriptors = Array.isArray(stdio) ? stdio : [stdio, stdio, stdio];
    const pipes = descriptors.map((mode, fd) => {
      if (mode !== "pipe" && mode !== "overlapped") return null;
      return new Duplex({
        read() { request({ type: "resume", id, fd }); },
        write(data, encoding, done) {
          request({ type: "write", id, fd, data: Buffer.from(data) });
          // Writes are serialized by Node in the broker. The input is bounded by
          // the normal stream high-water mark and acknowledgements below.
          pendingWrites.set(fd, done);
        },
        final(done) { request({ type: "end", id, fd }); done(); },
      });
    });
    Object.assign(child, { stdio: pipes, stdin: pipes[0] ?? null, stdout: pipes[1] ?? null, stderr: pipes[2] ?? null });
    child.kill = (signal = "SIGTERM") => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      request({ type: "kill", id, signal });
      Object.assign(child, { killed: true });
      return true;
    };
    child.send = (message, done) => { request({ type: "ipc", id, message }); done?.(null); return true; };
    child.disconnect = () => { request({ type: "disconnect", id }); Object.assign(child, { connected: false }); };
    child.unref = () => request({ type: "unref", id });
    child.ref = () => request({ type: "ref", id });
    const abort = () => child.kill(options.killSignal ?? "SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.once("close", () => signal?.removeEventListener("abort", abort));
    children.set(id, { child, callback, pendingWrites });
    try { request({ type, id, command, args, options: serializable }); }
    catch (error) { queueMicrotask(() => finishError(id, error)); }
    return child;
  }
  function finishError(id, error) {
    const entry = children.get(id);
    if (!entry) return;
    children.delete(id);
    entry.callback?.(error, "", "");
    entry.child.emit("error", error);
    for (const stream of entry.child.stdio) stream?.destroy();
    // A lost broker is not an observed OS exit. Never manufacture an exit
    // code or claim a running engine was reaped when its outcome is unknown.
    entry.child.emit("close", null, null);
  }
  transport.subscribe(message => {
    if (message.type === "shutdown-complete") { stopped?.(); return; }
    const entry = children.get(message.id);
    if (!entry) return;
    const { child, callback } = entry;
    switch (message.type) {
      case "spawn":
        child.pid = message.pid;
        child.connected = message.connected;
        child.emit("spawn");
        break;
      case "data": {
        const stream = child.stdio[message.fd];
        if (!stream || stream.push(Buffer.from(message.data))) request({ type: "resume", id: message.id, fd: message.fd });
        break;
      }
      case "end": child.stdio[message.fd]?.push(null); break;
      case "written": {
        const done = entry.pendingWrites.get(message.fd);
        entry.pendingWrites.delete(message.fd);
        done?.(message.error ? Object.assign(new Error(message.error.message), message.error) : null);
        break;
      }
      case "message": child.emit("message", message.message); break;
      case "disconnect": child.connected = false; child.emit("disconnect"); break;
      case "error": child.emit("error", Object.assign(new Error(message.error.message), message.error)); break;
      case "result": callback?.(message.error ? Object.assign(new Error(message.error.message), message.error) : null, message.stdout, message.stderr); break;
      case "exit":
        child.exitCode = message.code;
        child.signalCode = message.signal;
        child.emit("exit", message.code, message.signal);
        break;
      case "close":
        children.delete(message.id);
        child.emit("close", message.code, message.signal);
        break;
    }
  });
  transport.onClose(() => {
    failed = true;
    for (const id of [...children.keys()]) finishError(id, new Error("Desktop launch broker exited; process outcome unknown. Restart OpenWork to retry."));
  });
  return {
    spawn: (command, args, options) => launch("spawn", command, args, options),
    execFile: (command, args, options, callback) => launch("exec", command, args, options, callback),
    shutdown() {
      if (failed) throw new Error("Desktop launch broker unavailable; restart OpenWork to retry");
      const finished = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Desktop launch broker did not confirm child cleanup")), 10_000);
        stopped = () => { clearTimeout(timer); resolve(); };
      });
      request({ type: "shutdown" });
      return finished;
    },
  };
}
