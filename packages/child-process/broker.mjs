import { spawn, execFile } from "node:child_process";

function serializeError(error) {
  return { message: error.message, code: error.code, errno: error.errno, syscall: error.syscall, killed: error.killed, signal: error.signal };
}

/** Runs only in the launch process, never Electron main. */
export function serveProcessLauncher(transport) {
  const children = new Map();
  const detached = new Set();
  let closing = false;
  let connected = true;
  const send = message => { if (connected) transport.send(message); };
  function confirmShutdown() {
    if (closing && [...children.values()].every(child => detached.has(child))) send({ type: "shutdown-complete" });
  }
  function kill(child, signal) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32" && child.pid) {
      // Node's Windows kill only terminates the direct child. Descendants must
      // not retain engine locks, MCP credentials or workspace file handles.
      const terminator = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      terminator.on("error", () => { child.kill(signal); });
      terminator.once("exit", code => { if (code !== 0) child.kill(signal); });
    } else child.kill(signal);
  }
  function shutdown() {
    if (closing) return;
    closing = true;
    for (const child of children.values()) if (!detached.has(child)) kill(child, "SIGKILL");
    confirmShutdown();
  }
  transport.subscribe(message => {
    if (message.type === "shutdown") { shutdown(); return; }
    if (closing) return;
    const { id } = message;
    if (message.type === "spawn" || message.type === "exec") {
      let child;
      try {
        child = message.type === "exec"
          ? execFile(message.command, message.args, message.options, (error, stdout, stderr) => send({ type: "result", id, error: error ? serializeError(error) : null, stdout, stderr }))
          : spawn(message.command, message.args, message.options);
      } catch (error) {
        send({ type: "error", id, error: serializeError(error) });
        send({ type: "close", id, code: null, signal: null });
        return;
      }
      if (message.options.detached === true) detached.add(child);
      children.set(id, child);
      child.once("spawn", () => send({ type: "spawn", id, pid: child.pid, connected: child.connected }));
      child.on("error", error => send({ type: "error", id, error: serializeError(error) }));
      child.on("message", value => send({ type: "message", id, message: value }));
      child.once("disconnect", () => send({ type: "disconnect", id }));
      child.once("exit", (code, signal) => send({ type: "exit", id, code, signal }));
      child.once("close", (code, signal) => {
        children.delete(id);
        detached.delete(child);
        send({ type: "close", id, code, signal });
        confirmShutdown();
      });
      child.stdio.forEach((stream, fd) => {
        if (!stream || fd === 0 || !("pause" in stream)) return;
        stream.on("data", data => {
          stream.pause();
          send({ type: "data", id, fd, data });
        });
        stream.once("end", () => send({ type: "end", id, fd }));
        // An extra anonymous input pipe (v2 credentials) has no reader in the
        // parent. Pipe errors are returned to its writer, not logged.
        stream.on("error", () => undefined);
      });
      return;
    }
    const child = children.get(id);
    if (!child) return;
    switch (message.type) {
      case "kill": kill(child, message.signal); break;
      case "write": {
        const stream = child.stdio[message.fd];
        if (stream && "write" in stream) stream.write(Buffer.from(message.data), error => send({ type: "written", id, fd: message.fd, error: error ? serializeError(error) : null }));
        else send({ type: "written", id, fd: message.fd, error: { message: "Child pipe unavailable", code: "EPIPE" } });
        break;
      }
      case "end": child.stdio[message.fd]?.end(); break;
      case "resume": child.stdio[message.fd]?.resume(); break;
      case "ipc": if (child.connected) child.send(message.message, () => undefined); break;
      case "disconnect": if (child.connected) child.disconnect(); break;
      case "unref": child.unref(); break;
      case "ref": child.ref(); break;
    }
  });
  transport.onClose(() => { connected = false; shutdown(); });
  return { shutdown };
}
