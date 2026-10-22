import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installProcessLauncher } from "../../packages/child-process/index.mjs";
import { createManagedOpencodeV2Server, EngineV2StartupTimeoutError } from "../../apps/server/src/managed-opencode-v2.ts";
import { orphanedPackagedSidecarPids } from "../../apps/desktop/electron/runtime.mjs";
import { probeEngineV2Path, ENGINE_V2_VERSION_PROBE_TIMEOUT_MS } from "../../apps/server/src/engine-v2-version-probe.ts";
import { test } from "@openwork/testkit";
import { createProcessLauncher } from "../../packages/child-process/client.mjs";

function broker(delayMs = 0) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.module).then(({ serveProcessLauncher }) => {
      serveProcessLauncher({
        send: value => parentPort.postMessage(value),
        subscribe: receive => parentPort.on('message', value => {
          if (value.type === 'spawn' && workerData.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.delayMs);
          receive(value);
        }),
        onClose: receive => parentPort.once('close', receive),
      });
      parentPort.postMessage({ ready: true });
    });`, { eval: true, workerData: { module: new URL("../../packages/child-process/broker.mjs", import.meta.url).href, delayMs } });
  const launcher = createProcessLauncher({
    send: (value: unknown) => worker.postMessage(value),
    subscribe: (receive: (value: unknown) => void) => worker.on("message", receive),
    onClose: (receive: () => void) => worker.once("exit", receive),
  });
  return { worker, launcher, async close() { await launcher.shutdown(); await worker.terminate(); } };
}

function collect(stream: NodeJS.ReadableStream | null): () => string {
  let value = "";
  stream?.on("data", chunk => { value += String(chunk); });
  return () => value;
}

test("broker preserves pid, cwd, env, both output streams and nonzero exit", async () => {
  const host = broker();
  try {
    const child = host.launcher.spawn(process.execPath, ["-e", "process.stdout.write(process.cwd() + ':' + process.env.BROKER_FIXTURE); process.stderr.write('diagnostic'); process.exitCode = 7"], {
      cwd: process.cwd(), env: { ...process.env, BROKER_FIXTURE: "fixture" }, stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const closed = once(child, "close");
    await once(child, "spawn");
    assert.equal(typeof child.pid, "number");
    assert.notEqual(child.pid, process.pid);
    const [code, signal] = await closed;
    assert.equal(code, 7);
    assert.equal(signal, null);
    assert.equal(stdout(), `${process.cwd()}:fixture`);
    assert.equal(stderr(), "diagnostic");
  } finally { await host.close(); }
});

test("broker relays private extra input pipe without placing the payload in argv or env", async () => {
  const host = broker();
  try {
    const child = host.launcher.spawn(process.execPath, ["-e", "require('node:fs').createReadStream(null, { fd: 3 }).pipe(process.stdout)"], {
      env: {}, stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    const stdout = collect(child.stdout);
    const closed = once(child, "close");
    child.stdio[3]?.end("fixture-only-private-payload");
    assert.equal((await closed)[0], 0);
    assert.equal(stdout(), "fixture-only-private-payload");
  } finally { await host.close(); }
});

test("broker execFile enforces child runtime timeout and keeps the callback contract", async () => {
  const host = broker();
  try {
    const result = await new Promise<{ error: NodeJS.ErrnoException | null; stdout: string; stderr: string }>(resolve => {
      host.launcher.execFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 100 }, (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => resolve({ error, stdout, stderr }));
    });
    assert.ok(result.error);
    assert.equal(result.stdout, "");
  } finally { await host.close(); }
});

test("broker kill exits the child without terminating an unrelated process", async () => {
  const host = broker();
  try {
    const child = host.launcher.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const closed = once(child, "close");
    await once(child, "spawn");
    assert.equal(child.kill("SIGTERM"), true);
    await closed;
    assert.ok(child.signalCode !== null || child.exitCode !== null);
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  } finally { await host.close(); }
});

test("a stalled native admission in the broker does not block the caller heartbeat", async () => {
  const host = broker(600);
  let beats = 0;
  const heartbeat = setInterval(() => { beats++; }, 20);
  try {
    const child = host.launcher.spawn(process.execPath, ["-e", "process.stdout.write('ready')"], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = collect(child.stdout);
    assert.equal((await once(child, "close"))[0], 0);
    assert.ok(beats >= 15, `caller heartbeat only advanced ${beats} times`);
    assert.equal(stdout(), "ready");
  } finally { clearInterval(heartbeat); await host.close(); }
});

test("broker crash fails pending creation once and never replays it", async () => {
  const host = broker(2_000);
  const child = host.launcher.spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  let errors = 0;
  child.on("error", () => { errors++; });
  const closed = new Promise(resolve => child.once("close", resolve));
  await host.worker.terminate();
  await closed;
  assert.equal(errors, 1);
  assert.equal(child.pid, undefined);
  assert.throws(() => host.launcher.shutdown(), /unavailable/);
});

test("graceful broker shutdown confirms a live managed child has stopped", async () => {
  const host = broker();
  const child = host.launcher.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  const pid = child.pid;
  assert.ok(typeof pid === "number");
  await host.close();
  assert.throws(() => process.kill(pid, 0));
});

test("migration-style IPC reaches the real child and its reply returns over the private channel", async () => {
  const host = broker();
  try {
    const child = host.launcher.spawn(process.execPath, ["-e", "process.on('message', value => { process.send({ received: value }); process.disconnect(); })"], { stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "json" });
    const reply = once(child, "message");
    const closed = once(child, "close");
    await once(child, "spawn");
    assert.equal(child.connected, true);
    child.send({ fixture: "migration" });
    assert.deepEqual((await reply)[0], { received: { fixture: "migration" } });
    assert.equal((await closed)[0], 0);
    assert.equal(child.connected, false);
  } finally { await host.close(); }
});

test("packaged orphan detection spares engines below another live app's launch broker", () => {
  const rows = [
    { pid: 10, ppid: 1, command: "/bundle/OpenWork" },
    { pid: 11, ppid: 10, command: "/bundle/Helper --type=utility" },
    { pid: 12, ppid: 11, command: "/bundle/sidecars/opencode2 serve" },
    { pid: 20, ppid: 1, command: "/bundle/sidecars/opencode2 serve" },
    { pid: 30, ppid: 1, command: "/elsewhere/sidecars/opencode2 serve" },
  ];
  assert.deepEqual(orphanedPackagedSidecarPids(rows, {
    sidecarDirs: ["/bundle/sidecars"], appExecutables: ["/bundle/OpenWork"], selfPid: 99,
  }), [20]);
});

test("large output is backpressured and delivered without truncation or deadlock", async () => {
  const host = broker();
  try {
    const child = host.launcher.spawn(process.execPath, ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = collect(child.stdout);
    assert.equal((await once(child, "close"))[0], 0);
    assert.equal(stdout().length, 2 * 1024 * 1024);
  } finally { await host.close(); }
});

async function fakeEngine() {
  const root = await mkdtemp(join(tmpdir(), "openwork-launch-broker-"));
  const bin = join(root, "fixture-engine.mjs");
  const config = join(root, "fixture.json");
  const pidPath = join(root, "fixture.pid");
  await writeFile(bin, `#!${process.execPath}\nimport { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, 'utf8'));
writeFileSync(config.pidPath, String(process.pid));
setTimeout(() => {
  const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 'fixture', pid: process.pid })); });
  server.listen(0, '127.0.0.1', () => process.stdout.write('server listening on http://127.0.0.1:' + server.address().port + '\\n'));
}, config.delayMs);
setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const setDelay = (delayMs: number) => writeFile(config, JSON.stringify({ delayMs, pidPath }));
  await setDelay(0);
  return { root, bin, config, pidPath, setDelay };
}

test("v2 health's deadline excludes delayed broker admission and retains the real engine pid", async () => {
  const fixture = await fakeEngine();
  const host = broker(600);
  const uninstall = installProcessLauncher(host.launcher);
  let engine: Awaited<ReturnType<typeof createManagedOpencodeV2Server>> | undefined;
  try {
    engine = await createManagedOpencodeV2Server({ bin: fixture.bin, rootDir: join(fixture.root, "engine"), bootTimeoutMs: 500, env: { OPENCODE_CONFIG: fixture.config } });
    assert.equal((await engine.health()).pid, engine.childPid);
    assert.equal(engine.childPid, Number(await readFile(fixture.pidPath, "utf8")));
    assert.equal(engine.exitCode, null);
  } finally { await engine?.close(); uninstall(); await host.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test("a v2 health timeout terminates its child and a later attempt can succeed", async () => {
  const fixture = await fakeEngine();
  let engine: Awaited<ReturnType<typeof createManagedOpencodeV2Server>> | undefined;
  try {
    await fixture.setDelay(5_000);
    await assert.rejects(createManagedOpencodeV2Server({ bin: fixture.bin, rootDir: join(fixture.root, "engine"), bootTimeoutMs: 500, env: { OPENCODE_CONFIG: fixture.config } }), EngineV2StartupTimeoutError);
    const oldPid = Number(await readFile(fixture.pidPath, "utf8"));
    assert.throws(() => process.kill(oldPid, 0));
    await fixture.setDelay(0);
    engine = await createManagedOpencodeV2Server({ bin: fixture.bin, rootDir: join(fixture.root, "engine"), bootTimeoutMs: 1_000, env: { OPENCODE_CONFIG: fixture.config } });
    assert.equal((await engine.health()).healthy, true);
    assert.notEqual(engine.childPid, oldPid);
  } finally { await engine?.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test("the v2 PATH version probe is bounded, kills a stalled command and marks it retryable", async () => {
  assert.equal(ENGINE_V2_VERSION_PROBE_TIMEOUT_MS, 180_000);
  const root = await mkdtemp(join(tmpdir(), "openwork-version-probe-"));
  const bin = join(root, "stalled-version.mjs");
  const pidPath = join(root, "pid");
  await writeFile(bin, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const host = broker();
  const uninstall = installProcessLauncher(host.launcher);
  try {
    await assert.rejects(probeEngineV2Path(bin, 500), EngineV2StartupTimeoutError);
    const pid = Number(await readFile(pidPath, "utf8"));
    assert.throws(() => process.kill(pid, 0));
  } finally { uninstall(); await host.close(); await rm(root, { recursive: true, force: true }); }
});
