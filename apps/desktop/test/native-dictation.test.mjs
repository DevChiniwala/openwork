import { test } from "node:test";
import assert from "node:assert/strict";
import { createNativeDictation, windowsDictationScript } from "../electron/native-dictation.mjs";

function surface() {
  const sender = { mainFrame: {}, isFocused: () => true };
  return { event: { sender, senderFrame: sender.mainFrame }, window: { webContents: sender, isFocused: () => true } };
}

function action(options) {
  const adapter = createNativeDictation(options);
  return (event, window) => adapter.start(event, window, "request-1");
}

test("macOS sends only the native dictation action to the trusted focused main frame", async () => {
  const actions = [];
  const start = action({ platform: "darwin", menu: { sendActionToFirstResponder: action => actions.push(action) } });
  const { event, window } = surface();
  assert.deepEqual(await start(event, window), { ok: true });
  assert.deepEqual(actions, ["startDictation:"]);
  assert.deepEqual(await start({ ...event, senderFrame: {} }, window), { ok: false, reason: "not_focused" });
  assert.deepEqual(await start(event, { ...window, isFocused: () => false }), { ok: false, reason: "not_focused" });
  assert.deepEqual(await start(event, { ...window, webContents: {} }), { ok: false, reason: "not_focused" });
  event.sender.isFocused = () => false;
  assert.deepEqual(await start(event, window), { ok: false, reason: "not_focused" });
  assert.equal(actions.length, 1);
});

test("Windows uses the system executable and fixed chord, and bounds a blocked helper", async () => {
  const calls = [];
  const start = action({ platform: "win32", processId: 1234, systemRoot: "C:\\Windows", execute: async (...args) => { calls.push(args); } });
  const { event, window } = surface();
  assert.deepEqual(await start(event, window), { ok: true });
  assert.equal(calls[0][0], "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(calls[0][1].slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(calls[0][2].timeout, 8000);
  assert.equal(calls[0][2].windowsHide, true);
  assert.match(calls[0][1][3], /pid != 1234/);
  assert.match(calls[0][1][3], /GetAsyncKeyState/);
  assert.throws(() => windowsDictationScript("1234; injected"));
});

test("helper failure is recoverable and repeated clicks cannot toggle dictation twice", async () => {
  let reject;
  let calls = 0;
  const start = action({ platform: "win32", processId: 1234, systemRoot: "C:\\Windows", execute: () => {
    calls++;
    return new Promise((_resolve, fail) => { reject = fail; });
  } });
  const { event, window } = surface();
  const first = start(event, window);
  assert.deepEqual(await start(event, window), { ok: false, reason: "failed" });
  assert.equal(calls, 1);
  reject(new Error("System policy blocked PowerShell"));
  assert.deepEqual(await first, { ok: false, reason: "failed" });
  const retry = start(event, window);
  assert.equal(calls, 2);
  reject(new Error("No voice typing"));
  assert.deepEqual(await retry, { ok: false, reason: "failed" });
});

test("unsupported systems never launch a helper", async () => {
  const { event, window } = surface();
  const start = action({ platform: "linux", execute: () => assert.fail("must not execute") });
  assert.deepEqual(await start(event, window), { ok: false, reason: "unavailable" });
});

test("only the owning main frame can cancel its pending launch", async () => {
  let signal;
  const adapter = createNativeDictation({ platform: "win32", processId: 1234, systemRoot: "C:\\Windows", execute: (_file, _args, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
  } });
  const { event, window } = surface();
  const launch = adapter.start(event, window, "request-1");
  assert.equal(adapter.cancel(event, "other-request"), false);
  assert.equal(adapter.cancel({ ...event, senderFrame: {} }, "request-1"), false);
  assert.equal(adapter.cancel(surface().event, "request-1"), false);
  assert.equal(signal.aborted, false);
  assert.equal(adapter.cancel(event, "request-1"), true);
  assert.equal(signal.aborted, true);
  assert.deepEqual(await launch, { ok: false, reason: "failed" });
});
