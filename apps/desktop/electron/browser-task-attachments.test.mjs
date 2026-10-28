import assert from "node:assert/strict";
import { File } from "node:buffer";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { createBrowserTaskHost } from "./browser-task.mjs";

// Exercise the actual serialized isolated-world functions through the host, not
// a duplicate of the DOM helper. No Electron, network, chooser or local paths.
function fixture({ hidden = false, multiple = true, allowed = async () => true } = {}) {
  const events = [], scripts = [], policy = [];
  class Element {
    constructor() {
      this.tagName = "INPUT";
      this.type = "file";
      this.isConnected = true;
      this.disabled = false;
      this.multiple = multiple;
      this.webkitdirectory = false;
      this.accept = ".txt";
      this.innerText = "";
      this.labels = [{ innerText: "Upload files" }];
      this.rect = { x: 20, y: 30, width: hidden ? 0 : 100, height: hidden ? 0 : 20 };
    }
    matches(selector) {
      if (selector.includes('type="password"') || selector.includes('autocomplete="one-time-code"')) return false;
      return selector === ":disabled" && this.disabled;
    }
    getBoundingClientRect() { return { ...this.rect }; }
    getAttribute(name) { return name === "name" ? "attachment" : null; }
    hasAttribute(name) { return name === "disabled" && this.disabled; }
    contains(element) { return element === this; }
    dispatchEvent(event) { events.push(event.type); this.onEvent?.(event); }
  }
  class Input extends Element {
    #files = [];
    get files() { return this.#files; }
    set files(files) { this.#files = files; this.assignments = (this.assignments || 0) + 1; }
  }
  class DataTransfer {
    files = [];
    items = { add: file => this.files.push(file) };
  }
  const input = new Input();
  let currentNodes = [input], url = "https://example.test/upload", owner = "session";
  const document = {
    title: "Upload", body: { innerText: "Choose a file" }, activeElement: input,
    querySelectorAll(selector) { return selector.startsWith('input[type="password"') ? [] : currentNodes; },
    elementFromPoint() { return input; },
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const context = createContext({
    document, HTMLElement: Element, HTMLInputElement: Input,
    HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
    getComputedStyle: () => ({ visibility: "visible", display: hidden ? "none" : "block" }),
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
    MutationObserver, DataTransfer, File, Event, Uint8Array, atob,
  });
  const contents = {
    getURL: () => url, isDestroyed: () => false, stop() {},
    executeJavaScriptInIsolatedWorld(world, entries) {
      assert.equal(world, 1001);
      scripts.push(entries[0].code);
      return Promise.resolve().then(() => runInContext(entries[0].code, context));
    },
  };
  const tab = { tabId: "tab", webMcpRevision: 0, view: { webContents: contents } };
  const host = createBrowserTaskHost({
    getTab: id => id === tab.tabId ? tab : null,
    tabsFor: () => [tab], ownerOf: () => owner, activeFor: () => tab.tabId,
    isVisible: () => true, enabled: () => true, changed() {},
    allowed: async (address, request) => { policy.push({ address, request }); return allowed(address, request); },
  });
  const request = (operation, args, options) => host.request({ sessionId: "session", operation, args }, options);
  return {
    host, input, context, events, scripts, policy, tab, request,
    observe: () => request("observe"),
    attach: (observationId, files = [{ name: "résumé.txt", bytesBase64: "AP9h" }], options) => request("act", { observationId, action: { type: "attach_files", ref: "e1", files } }, options),
    mutate: () => context.__openworkBrowserObservation.observer.callback(),
    replace: () => { input.isConnected = false; currentNodes = [new Input()]; },
    navigate: () => { url = "https://example.test/other"; tab.webMcpRevision++; },
    changeOwner: () => { owner = "other"; },
  };
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

for (const hidden of [false, true]) {
  test(`native file attachment (${hidden ? "hidden" : "visible"}) preserves bytes, verifies values and consumes the reference`, async () => {
    const f = fixture({ hidden });
    const observation = await f.observe();
    assert.equal(observation.ok, true);
    assert.equal(observation.elements[0].inputType, "file");
    assert.equal(observation.elements[0].hidden, hidden);
    const result = await f.attach(observation.observationId);
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "verified");
    assert.equal(result.retrySafe, false);
    assert.deepEqual(plain(result.files), [{ name: "résumé.txt", size: 3 }]);
    assert.deepEqual([...new Uint8Array(await f.input.files[0].arrayBuffer())], [0, 255, 97]);
    assert.deepEqual(f.events, ["input", "change"]);
    assert.equal(f.input.assignments, 1);
    assert.ok(f.policy.some(call => call.request?.method === "POST" && call.request.hasUpload === true));
    assert.equal((await f.attach(observation.observationId)).code, "stale_observation");
    assert.equal(f.input.assignments, 1);
  });
}

test("file MIME type survives native assignment", async () => {
  const f = fixture();
  const observation = await f.observe();
  const result = await f.attach(observation.observationId, [{ name: "clip.mp4", mimeType: "video/mp4", bytesBase64: "YQ==" }]);
  assert.equal(result.outcome, "verified");
  assert.equal(f.input.files[0].type, "video/mp4");
});

test("cancellation while assignment is in flight retains an uncertain dispatch receipt", async () => {
  const f = fixture();
  const observation = await f.observe();
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const original = f.tab.view.webContents.executeJavaScriptInIsolatedWorld;
  f.tab.view.webContents.executeJavaScriptInIsolatedWorld = async (...args) => {
    const result = await original(...args);
    enter();
    await waiting;
    return result;
  };
  const controller = new AbortController();
  const pending = f.attach(observation.observationId, undefined, { signal: controller.signal });
  await entered;
  controller.abort();
  const result = await pending;
  assert.equal(result.mayHaveChangedState, true);
  assert.equal(result.retrySafe, false);
  assert.equal(f.input.assignments, 1);
  release();
});

test("multiple files and zero-byte files verify in selection order", async () => {
  const f = fixture();
  const observation = await f.observe();
  const result = await f.attach(observation.observationId, [{ name: "empty.txt", bytesBase64: "" }, { name: "a.txt", bytesBase64: "YQ==" }]);
  assert.equal(result.outcome, "verified");
  assert.deepEqual(plain(result.files), [{ name: "empty.txt", size: 0 }, { name: "a.txt", size: 1 }]);
});

test("managed upload denial occurs before bytes enter the isolated world", async () => {
  const f = fixture({ allowed: async (_, request) => !request?.hasUpload });
  const observation = await f.observe();
  const scripts = f.scripts.length;
  const result = await f.attach(observation.observationId);
  assert.equal(result.code, "upload_blocked");
  assert.equal(result.dispatched, false);
  assert.equal(f.scripts.length, scripts);
  assert.equal(f.input.assignments, undefined);
});

for (const [label, modify, code] of [
  ["DOM mutation", f => f.mutate(), "stale_observation"],
  ["detached/replaced control", f => f.replace(), "stale_element"],
  ["bounds movement", f => { f.input.rect.x++; }, "stale_observation"],
  ["non-file input", f => { f.input.type = "text"; }, "not_file_input"],
  ["disabled control", f => { f.input.disabled = true; }, "element_disabled"],
  ["directory input", f => { f.input.webkitdirectory = true; }, "not_file_input"],
  ["navigation", f => f.navigate(), "stale_observation"],
  ["ownership change", f => f.changeOwner(), "wrong_conversation"],
]) {
  test(`${label} cannot receive files`, async () => {
    const f = fixture();
    const observation = await f.observe();
    modify(f);
    const result = await f.attach(observation.observationId);
    assert.equal(result.code, code);
    assert.equal(f.input.assignments, undefined);
  });
}

test("single-file controls reject a multiple selection", async () => {
  const f = fixture({ multiple: false });
  const observation = await f.observe();
  const result = await f.attach(observation.observationId, [{ name: "a", bytesBase64: "" }, { name: "b", bytesBase64: "" }]);
  assert.equal(result.code, "multiple_files_not_allowed");
  assert.equal(f.input.assignments, undefined);
});

test("input/change handlers that clear the selection produce value_mismatch without replay", async () => {
  const f = fixture();
  f.input.onEvent = event => { if (event.type === "change") f.input.files = []; };
  const observation = await f.observe();
  const result = await f.attach(observation.observationId);
  assert.equal(result.outcome, "value_mismatch");
  assert.equal(result.dispatched, true);
  assert.equal(result.retrySafe, false);
  assert.equal((await f.attach(observation.observationId)).code, "stale_observation");
  assert.deepEqual(f.events, ["input", "change"]);
});

test("a lost isolated-world result reports uncertain dispatch and cannot replay", async () => {
  const f = fixture();
  const observation = await f.observe();
  const original = f.tab.view.webContents.executeJavaScriptInIsolatedWorld;
  f.tab.view.webContents.executeJavaScriptInIsolatedWorld = async (...args) => { await original(...args); throw new Error("Result lost"); };
  const result = await f.attach(observation.observationId);
  assert.equal(result.ok, false);
  assert.equal(result.mayHaveChangedState, true);
  assert.equal(result.next, "observe_before_retry");
  assert.equal((await f.attach(observation.observationId)).code, "stale_observation");
  assert.equal(f.input.assignments, 1);
});

for (const kind of ["takeover", "cancellation", "navigation", "ownership"]) {
  test(`${kind} during upload authorization prevents assignment`, async () => {
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    const f = fixture({ allowed: async (_, request) => {
      if (request?.hasUpload) { enter(); await waiting; }
      return true;
    } });
    const observation = await f.observe();
    const controller = new AbortController();
    const pending = f.attach(observation.observationId, undefined, { signal: controller.signal });
    await entered;
    if (kind === "takeover") f.host.pause("tab");
    if (kind === "cancellation") controller.abort();
    if (kind === "navigation") f.navigate();
    if (kind === "ownership") f.changeOwner();
    release();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, false);
    assert.equal(f.input.assignments, undefined);
    assert.equal(f.scripts.length, 1, "only the observation script should have run");
  });
}

for (const files of [
  [], [{ name: "../a", bytesBase64: "YQ==" }], [{ name: "C:\\a", bytesBase64: "YQ==" }],
  [{ name: "bad\0name", bytesBase64: "YQ==" }], [{ name: "a", bytesBase64: "?" }],
  [{ name: "a", bytesBase64: "YR==" }], [{ name: "a", path: "/not/accepted" }],
]) {
  test(`invalid payload ${JSON.stringify(files)} is rejected without dispatch`, async () => {
    const f = fixture();
    const observation = await f.observe();
    const result = await f.attach(observation.observationId, files);
    assert.equal(result.code, "invalid_attachment");
    assert.equal(result.dispatched, false);
    assert.equal(f.scripts.length, 1);
  });
}

test("the host enforces the aggregate 32 MiB limit", async () => {
  const f = fixture();
  const observation = await f.observe();
  const result = await f.attach(observation.observationId, [
    { name: "large.bin", bytesBase64: Buffer.alloc(32 * 1024 * 1024).toString("base64") },
    { name: "extra.bin", bytesBase64: "AA==" },
  ]);
  assert.equal(result.code, "attachment_too_large");
  assert.equal(result.dispatched, false);
  assert.equal(f.scripts.length, 1);
});

test("browser panel forwards upload shape to the actual managed policy callback and fails closed", async () => {
  const source = await readFile(new URL("./browser-panel.mjs", import.meta.url), "utf8");
  const match = source.match(/  async function browserTaskAllowed\(url, request = \{\}\) \{[\s\S]*?\n  \}/);
  const check = source.match(/  async function checkBrowserPolicy\(input\) \{[\s\S]*?\n  \}/);
  assert.ok(match);
  assert.ok(check);
  const calls = [];
  const run = (checkPolicy, browserControlEnabled = true) => runInNewContext(`(${match[0].trim()})`, {
    browserControlEnabled, checkPolicy,
    checkBrowserPolicy: runInNewContext(`(${check[0].trim()})`, {
      websiteDecision: () => ({ effect: "allow" }), checkPolicy,
    }),
  });
  const request = { method: "POST", hasUpload: true };
  assert.equal(await run(async input => { calls.push(input); })("https://example.test/upload", request), true);
  assert.deepEqual(plain(calls), [{ ...request, url: "https://example.test/upload" }]);
  assert.equal(await run(async () => { throw new Error("Denied"); })("https://example.test/upload", request), false);
  assert.equal(await run(undefined)("https://example.test/upload", request), false);
  assert.equal(await run(async () => {}, false)("https://example.test/upload", request), false);
});
