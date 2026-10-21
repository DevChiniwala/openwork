import assert from "node:assert/strict";
import test from "node:test";
import { createComputerControl, COMPUTER_PROTOCOL } from "@openwork/computer-use/computer-control";

const deferred = () => {
  let resolve = () => {};
  const promise = new Promise((done) => { resolve = () => done(undefined); });
  return { promise, resolve };
};
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const payload = (result) => JSON.parse(result.content.find((item) => item.type === "text").text);
function fixture(options = {}) {
  const calls = [];
  const requests = [];
  const selected = [];
  /** @type {(value: unknown) => void} */
  let emit = (_value) => {};
  let disconnect = () => {};
  /** @type {import("@openwork/computer-use/computer-control").ComputerAdapter} */
  const adapter = {
    id: "local", label: "This computer", placement: "local",
    protocol: COMPUTER_PROTOCOL,
    setup: async () => ({ setupId: "setup" }),
    readiness: options.readiness ?? (async () => ({ readiness: "ready", detail: "Ready" })),
    connect: async ({ onClose, onUi }) => {
      calls.push("connect");
      emit = onUi; disconnect = onClose;
      let paused = false;
      return {
        callTool: async (name, args) => {
          calls.push(name);
          await options.beforeTool?.(name);
          if (name === "computer_open_session") {
            onUi({ kind: "state", id: "view", phase: "working", appID: args.app_id, appName: "Editor", windowTitle: "Draft", mode: args.mode, task: args.purpose });
            return text({ ok: true, session_id: "native", window_id: 17, state: "active" });
          }
          if (name === "computer_session_status") return text({ ok: true, state: paused ? "paused" : "active" });
          return text({ ok: true, ...(name === "computer_observe" ? { observation_id: "observation" } : {}) });
        },
        notifyUi: async (value) => {
          selected.push(value);
          if (value.action === "takeover" || value.action === "resume") {
            paused = value.action === "takeover";
            onUi({ kind: "state", id: "view", phase: paused ? "paused" : "working", canContinue: paused });
          }
        },
        close: async () => { calls.push("close"); await options.beforeClose?.(); onClose(); },
      };
    },
  };
  /** @type {import("@openwork/computer-use/computer-control").ComputerAdapter} */
  const remote = { ...adapter, id: "vm", label: "VM", placement: "remote" };
  const control = createComputerControl({ adapters: options.remote ? [adapter, remote] : [adapter], readRemoteFeatureEnabled: options.authority, onRequest: (_sessionId, value) => { requests.push(value); }, idleMs: options.idleMs ?? 90_000 });
  return { control, calls, requests, selected, emit: value => emit(value), disconnect: () => disconnect() };
}

test("the rollout off blocks tools before connecting", async (t) => {
  const f = fixture(); t.after(() => f.control.reset(true));
  const result = await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} });
  assert.equal(payload(result).code, "computer_unavailable");
  assert.deepEqual(f.calls, []);
});

test("enabling the rollout gives a new chat access without a consent prompt", async (t) => {
  const f = fixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} })).ok, true);
  assert.deepEqual(f.requests, []);
  assert.ok(f.calls.includes("computer_discover"));
});

for (const remote of [false, true]) test(`${remote ? "configured remote" : "personal Mac"} opens immediately with no approval exchange`, async (t) => {
  const f = fixture({ remote, authority: async () => true }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  if (remote) { await f.control.setRemoteEnabled(true); await f.control.choose({ sessionId: "chat", targetId: "vm" }); }
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit the draft" } })).ok, true);
  assert.deepEqual(f.selected, []);
  assert.deepEqual(f.requests, []);
  assert.ok(f.calls.includes("computer_observe"));
  await assert.rejects(f.control.interact({ sessionId: "another-chat", id: "view", action: "takeover" }), /does not own/);
});

test("follow-ups and idle cleanup renew without approvals or replaying old input", async t => {
  const f = fixture({ idleMs: 10 }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit the draft" } });
  await f.control.endTurn({ sessionId: "chat" });
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_observe", args: {} })).ok, true);
  await new Promise(resolve => setTimeout(resolve, 35));
  const result = await f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "old", action: { type: "click", x: 1, y: 1 } } });
  assert.equal(payload(result).code, "observation_required");
  assert.equal(f.calls.filter(name => name === "computer_open_session").length, 3);
  assert.ok(!f.calls.includes("computer_act"));
  assert.deepEqual(f.selected, []);
});

test("human takeover survives end-of-turn and idle cleanup until Continue", async t => {
  const f = fixture({ idleMs: 10 }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit the draft" } });
  await f.control.interact({ sessionId: "chat", id: "view", action: "takeover" });
  await f.control.endTurn({ sessionId: "chat" });
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Follow up" } })).code, "session_paused");
  assert.equal((await f.control.presentation({ sessionId: "chat", visible: true })).phase, "paused");
  await assert.rejects(f.control.interact({ sessionId: "another", id: "view", action: "resume" }), /does not own/);
  await f.control.interact({ sessionId: "chat", id: "view", action: "resume" });
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_observe", args: {} })).ok, true);
  assert.ok(!f.calls.includes("computer_act"));
});

test("Stop ends the current task and the next turn works without asking again", async (t) => {
  const f = fixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} });
  await f.control.halt({ sessionId: "chat" });
  assert.ok(f.calls.includes("close"));
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} })).code, "not_allowed");
  await f.control.endTurn({ sessionId: "chat" });
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} })).ok, true);
  assert.deepEqual(f.requests, []);
});

test("changing computers preserves Stop until the next turn", async (t) => {
  const f = fixture({ remote: true, authority: async () => true });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.setRemoteEnabled(true);
  await f.control.choose({ sessionId: "chat", targetId: "local" });
  await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} });
  await f.control.halt({ sessionId: "chat" });
  const count = f.calls.length;
  for (const targetId of ["vm", "local"]) {
    assert.equal((await f.control.choose({ sessionId: "chat", targetId })).enabled, false);
    assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} })).code, "not_allowed");
    assert.equal(f.calls.length, count);
  }
  await f.control.endTurn({ sessionId: "chat" });
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} })).ok, true);
});

test("disable then re-enable during readiness cannot revive an old request", async (t) => {
  const probing = deferred(); const gate = deferred();
  const f = fixture({ readiness: async () => { probing.resolve(); await gate.promise; return { readiness: "ready", detail: "Ready" }; } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  const request = f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} });
  await probing.promise;
  await f.control.setFeatureEnabled(false);
  await f.control.setFeatureEnabled(true);
  gate.resolve();
  assert.equal(payload(await request).code, "computer_unavailable");
  assert.deepEqual(f.calls, []);
});

test("a turn ending during an admitted tool releases the computer as soon as that tool settles", async (t) => {
  const started = deferred(); const finish = deferred();
  const f = fixture({ beforeTool: async (name) => { if (name === "computer_discover") { started.resolve(); await finish.promise; } } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  const request = f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} });
  await started.promise;
  await f.control.endTurn({ sessionId: "chat" });
  finish.resolve();
  await request;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(f.calls.includes("close"));
  assert.equal((await f.control.snapshot({ sessionId: "chat" })).enabled, true);
});

test("VMs stay hidden until the resolved rollout enables them, then run without chat consent", async (t) => {
  let authorized = false;
  const f = fixture({ remote: true, authority: async () => authorized });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  assert.equal(await f.control.setRemoteEnabled(true), false);
  assert.deepEqual((await f.control.snapshot({ sessionId: "chat" })).targets.map((target) => target.id), ["local"]);
  await assert.rejects(f.control.choose({ sessionId: "chat", targetId: "vm" }), /listed computers/);
  authorized = true;
  assert.equal(await f.control.setRemoteEnabled(true), true);
  await f.control.choose({ sessionId: "chat", targetId: "vm" });
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} })).ok, true);
  assert.deepEqual(f.requests, []);
  await f.control.setRemoteEnabled(false);
  assert.ok(f.calls.includes("close"));
  assert.equal((await f.control.snapshot({ sessionId: "chat" })).placement, "local");
});

test("a revoked VM rollout blocks the next tool before connecting", async (t) => {
  let authorized = true;
  const f = fixture({ remote: true, authority: async () => authorized });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.setRemoteEnabled(true);
  await f.control.choose({ sessionId: "chat", targetId: "vm" });
  authorized = false;
  const result = await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} });
  assert.equal(payload(result).code, "computer_unavailable");
  assert.deepEqual(f.calls, []);
});


test("unexpected helper exit renews access but a native Stop cannot be bypassed", async t => {
  const f = fixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  const open = () => f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit the draft" } });
  await open(); f.disconnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_observe", args: {} })).ok, true);
  f.emit({ kind: "state", id: "view", phase: "closed", cause: "human_stop" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(payload(await open()).code, "not_allowed");
  assert.deepEqual(f.selected, []);
});


test("Stop racing turn cleanup is not rearmed by its late completion", async t => {
  const started = deferred(), finish = deferred();
  const f = fixture({ beforeClose: async () => { started.resolve(); await finish.promise; } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} });
  const ending = f.control.endTurn({ sessionId: "chat" }); await started.promise;
  const stopping = f.control.halt({ sessionId: "chat" }); finish.resolve();
  await ending; await stopping;
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} })).code, "not_allowed");
});
