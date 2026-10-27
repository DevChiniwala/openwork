import { afterEach, expect, jest, test } from "bun:test";
import { desktopFetchViaMain } from "../src/app/lib/desktop";
import { createClient, createDesktopFetch } from "../src/app/lib/opencode";

function installPermissionTransport() {
  const ipc: { command: string; url: string; init?: { method?: string; headers?: Record<string, string>; body?: string; transferId?: string } }[] = [];
  const renderer: Request[] = [];
  const raw: typeof fetch = async (input, init) => {
    renderer.push(new Request(input, init));
    return Response.json(true);
  };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: raw });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    fetch: raw,
    __OPENWORK_ELECTRON__: { invokeDesktop: async (command: string, url: string, init?: typeof ipc[number]["init"]) => {
      ipc.push({ command, url, init });
      return { status: 200, statusText: "OK", headers: [["content-type", "application/json"]], body: "true" };
    } },
  } });
  return { ipc, renderer };
}

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
afterEach(() => {
  jest.useRealTimers();
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

test.each(["once", "always", "reject"] satisfies Array<"once" | "always" | "reject">)("default permission %s reply uses main once with SDK body, auth and mounted scope", async (reply) => {
  const { ipc, renderer } = installPermissionTransport();
  for (const mount of ["", "/workspace/ws_fixture/opencode", "/proxy/w/ws_fixture/opencode"]) {
    const base = `http://127.0.0.1:8788${mount}`;
    const client = createClient(base, "/fixture/é", { mode: "openwork", token: "fixture-only" });
    const result = await client.permission.reply({ requestID: "per_fixture-1", reply });
    expect(result.data).toBe(true);
    expect(ipc.at(-1)).toMatchObject({ command: "__fetch", url: `${base}/permission/per_fixture-1/reply`, init: {
      method: "POST", body: JSON.stringify({ reply }), transferId: expect.any(String),
      headers: { authorization: "Bearer fixture-only", "content-type": "application/json", "x-opencode-directory": encodeURIComponent("/fixture/é") },
    } });
  }
  expect(ipc).toHaveLength(3);
  expect(renderer).toHaveLength(0);
});

test("permission Request/init overrides preserve method, body, header precedence and basic authentication", async () => {
  const { ipc, renderer } = installPermissionTransport();
  const url = "http://localhost:8788/permission/per_fixture/reply";
  const finite = createDesktopFetch({ username: "fixture", password: "test" });
  await finite(new Request(url, { method: "POST", headers: { "x-old": "old" }, body: '{"reply":"once"}' }), {
    headers: { "Content-Type": "application/json", Authorization: "Bearer explicit", "x-new": "new" },
    body: new Blob(['{"reply":"reject"}'], { type: "application/json" }),
  });
  expect(ipc[0]?.init).toMatchObject({ method: "POST", body: '{"reply":"reject"}', headers: { authorization: "Bearer explicit", "x-new": "new" } });
  expect(ipc[0]?.init?.headers?.["x-old"]).toBeUndefined();
  await finite(new URL(url), { method: "post", body: new Blob(['{"reply":"always"}'], { type: "application/json" }) });
  expect(ipc[1]?.init).toMatchObject({ method: "POST", body: '{"reply":"always"}', headers: { authorization: `Basic ${btoa("fixture:test")}` } });
  await finite(new Request(url), { method: "POST", body: '{"reply":"once"}' });
  expect(ipc[2]?.init?.method).toBe("POST");
  await finite(new Request(url, { method: "POST" }), { method: "DELETE" });
  expect(renderer[0]?.method).toBe("DELETE");
  expect(ipc).toHaveLength(3);
});

test("default routing excludes non-POST permission operations, lookalikes, prompts, questions and session writes", async () => {
  const { ipc, renderer } = installPermissionTransport();
  const finite = createDesktopFetch();
  for (const path of ["/permission", "/permissions/per_1/reply", "/notpermission/per_1/reply", "/permission//reply", "/permission/per_1/reply/", "/permission/per_1/reply/extra", "/permission/per_1/reply-other", "/permission/per%2F1/reply", "/permission/per_1/extra/reply", "/session/ses_1/prompt_async", "/session/ses_1/abort", "/session/ses_1/command", "/question/que_1/reply"]) {
    await finite(`http://127.0.0.1:8788${path}`, { method: "POST", body: "{}" });
  }
  for (const method of ["GET", "PATCH", "DELETE"]) await finite("http://127.0.0.1:8788/permission/per_1/reply", { method });
  await finite("http://127.0.0.1:8788/session/ses_1", { method: "PATCH", body: "{}" });
  await finite("http://127.0.0.1:8788/output?next=/permission/per_1/reply", { method: "POST", body: "{}" });
  expect(ipc).toHaveLength(0);
  expect(renderer).toHaveLength(18);
});

test.each(["deadline", "caller", "preaborted", "null override"])("permission %s cancellation is bounded, scoped to its transfer and never retries", async (cause) => {
  jest.useFakeTimers();
  const calls: string[] = [];
  let transferId: string | undefined;
  let rejectFetch: ((error: Error) => void) | undefined;
  let dispatched: (() => void) | undefined;
  const entered = new Promise<void>(resolve => { dispatched = resolve; });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __OPENWORK_ELECTRON__: {
    invokeDesktop: (command: string, value: string, init?: { transferId?: string; body?: string }) => {
      calls.push(command);
      if (command === "__cancelTransfer") {
        expect(value).toBe(transferId);
        rejectFetch?.(new Error("IPC request aborted"));
        return Promise.resolve(true);
      }
      transferId = init?.transferId;
      expect(init?.body).toBe('{"reply":"once"}');
      dispatched?.();
      return new Promise((_resolve, reject) => { rejectFetch = reject; });
    },
  } } });
  const original = new AbortController();
  const caller = new AbortController();
  const reason = new Error("fixture permission cancelled");
  if (cause === "preaborted") caller.abort(reason);
  const pending = createDesktopFetch()(new Request("http://127.0.0.1:8788/proxy/workspace/ws_fixture/opencode/permission/per_1/reply?directory=/fixture/a&next=/session/ses_1/command", {
    method: "POST", body: '{"reply":"once"}', signal: original.signal,
  }), { signal: cause === "null override" ? null : caller.signal }).catch((error: unknown) => error);
  if (cause === "preaborted") {
    expect(await pending).toBe(reason);
    expect(calls).toEqual([]);
    return;
  }
  await entered;
  expect(transferId).toBeString();
  original.abort();
  expect(calls).toEqual(["__fetch"]);
  if (cause === "caller") caller.abort(reason);
  else {
    jest.advanceTimersByTime(9_999);
    expect(calls).toEqual(["__fetch"]);
    jest.advanceTimersByTime(1);
  }
  const error = await pending;
  if (cause === "caller") expect(error).toBe(reason);
  else expect(error).toMatchObject({ message: "Request timed out." });
  jest.advanceTimersByTime(60_000);
  expect(calls).toEqual(["__fetch", "__cancelTransfer"]);
});

test("stream endpoints and effective SSE Accept headers stay native, unbuffered and untimed on default and explicit-main clients", async () => {
  jest.useFakeTimers();
  const { ipc } = installPermissionTransport();
  const streams: Response[] = [];
  Object.defineProperty(globalThis.window, "fetch", { value: async () => {
    const response = new Response(new ReadableStream<Uint8Array>());
    streams.push(response);
    return response;
  } });
  for (const finite of [createDesktopFetch(), createDesktopFetch(undefined, desktopFetchViaMain)]) {
    const base = "http://127.0.0.1:8788/workspace/ws_fixture/opencode";
    for (const path of ["/event", "/stream", "/permission/per_1/reply"]) {
      const response = await finite(new Request(`${base}${path}`, { method: "POST", body: "{}" }), {
        headers: { Accept: "text/event-stream" },
      });
      expect(response).toBe(streams.at(-1));
      expect(response.bodyUsed).toBe(false);
      expect(response.body?.locked).toBe(false);
      jest.advanceTimersByTime(60_000);
      await response.body?.cancel();
    }
  }
  expect(ipc).toHaveLength(0);
  expect(streams).toHaveLength(6);
});

test("web permission replies retain native fetch", async () => {
  const { ipc, renderer } = installPermissionTransport();
  Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
  const client = createClient("http://127.0.0.1:8788", "/fixture/a", { mode: "openwork", token: "fixture-only" });
  expect((await client.permission.reply({ requestID: "per_1", reply: "once" })).data).toBe(true);
  expect(renderer).toHaveLength(1);
  expect(renderer[0]?.headers.get("authorization")).toBe("Bearer fixture-only");
  expect(await renderer[0]?.json()).toEqual({ reply: "once" });
  expect(ipc).toHaveLength(0);
});

test("Stop's transport timeout cancels the native IPC request, without giving prompt or command POSTs read cancellation", async () => {
  jest.useFakeTimers();
  const calls: string[] = [];
  let transferId: string | undefined;
  let rejectFetch: ((error: Error) => void) | undefined;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __OPENWORK_ELECTRON__: {
    invokeDesktop: (command: string, value: string, init?: { transferId?: string }) => {
      calls.push(command);
      if (command === "__cancelTransfer") {
        expect(value).toBe(transferId);
        rejectFetch?.(new Error("IPC request aborted"));
        return Promise.resolve(true);
      }
      transferId = init?.transferId;
      return new Promise((_resolve, reject) => { rejectFetch = reject; });
    },
  } } });
  const finite = createDesktopFetch(undefined, desktopFetchViaMain);
  const abort = finite("http://127.0.0.1:8788/workspace/ws_fixture/opencode/session/ses_fixture/abort?directory=/fixture/a", { method: "POST" })
    .catch((error: unknown) => error);
  expect(transferId).toBeString();
  jest.advanceTimersByTime(10_000);
  expect(await abort).toMatchObject({ message: "Request timed out." });
  expect(calls).toEqual(["__fetch", "__cancelTransfer"]);
  for (const path of ["prompt_async", "command"]) {
    calls.length = 0;
    const request = finite(`http://127.0.0.1:8788/session/ses_fixture/${path}`, { method: "POST", body: "{}" })
      .catch((error: unknown) => error);
    expect(transferId).toBeUndefined();
    jest.advanceTimersByTime(10_000);
    expect(calls).toEqual(["__fetch"]);
    // Commands intentionally have no transport deadline, and prompt admission
    // has a longer one. Settle the mock explicitly rather than await either.
    rejectFetch?.(new Error("test cleanup"));
    await request;
    expect(calls).toEqual(["__fetch"]);
  }
});
