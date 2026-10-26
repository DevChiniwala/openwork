import { afterEach, expect, test } from "bun:test";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { buildOpenworkSessionSystemContext, clearOpenworkEnvSystemContextCache } from "../src/react-app/domains/session/sync/env-context";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  clearOpenworkEnvSystemContextCache();
});

function fixture(options: { renderer?: () => Promise<void> } = {}) {
  const main: Request[] = [];
  const renderer: Request[] = [];
  const directory = "/fixture/send";
  const session = (id: string) => ({ id, directory, parentID: id === "ses_child" ? "ses_root" : undefined, time: { created: 1, updated: 1 } });
  const messages = (id: string) => id === "ses_root" ? [
    { info: { id: "msg_user", sessionID: id, role: "user", time: { created: 1 } }, parts: [] },
    { info: { id: "msg_assistant", sessionID: id, parentID: "msg_user", role: "assistant", time: { created: 2 } }, parts: [{
      id: "prt_task", sessionID: id, messageID: "msg_assistant", type: "tool", tool: "task", callID: "call_child",
      state: { status: "running", input: { subagent_type: "explore" }, metadata: { sessionId: "ses_child" }, time: { start: 2 } },
    }] },
  ] : [];
  const respond = (request: Request) => {
    const path = new URL(request.url).pathname.replace("/workspace/ws_fixture/opencode", "");
    if (path === "/env/keys") return { keys: ["FIXTURE_KEY"] };
    if (path === "/path") return { directory, worktree: directory, home: directory, state: directory, config: directory };
    if (path === "/permission" || path === "/question") return [];
    if (path === "/session/status") return {};
    if (path.endsWith("/abort")) return true;
    const match = path.match(/^\/session\/(ses_root|ses_child)(\/message)?$/);
    if (!match) throw new Error(`Unexpected fixture request ${path}`);
    return match[2] ? messages(match[1]) : session(match[1]);
  };
  const raw: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    renderer.push(request);
    await options.renderer?.();
    return Response.json(respond(request));
  };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: raw });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { fetch: raw, __OPENWORK_ELECTRON__: {
    invokeDesktop: async (command: string, url: string, init: RequestInit) => {
      expect(command).toBe("__fetch");
      const request = new Request(url, init);
      main.push(request);
      return { status: 200, statusText: "OK", headers: [["content-type", "application/json"]], body: JSON.stringify(respond(request)) };
    },
  } } });
  return { main, renderer, directory, base: "http://127.0.0.1:8788/workspace/ws_fixture/opencode" };
}

test("ordinary-send environment preflight opts in without changing other environment reads or disclosing values", async () => {
  const world = fixture();
  const client = createOpenworkServerClient({ baseUrl: "http://127.0.0.1:8788", token: "fixture-client", hostToken: "fixture-host" });
  const context = await buildOpenworkSessionSystemContext(client, { cacheKey: "ses_root", readPendingChanges: () => false, desktopTransport: "main" });
  expect(context).toContain("FIXTURE_KEY");
  expect(context).not.toContain("fixture-host");
  expect(world.renderer).toHaveLength(0);
  expect(world.main).toHaveLength(1);
  expect(world.main[0].headers.get("authorization")).toBe("Bearer fixture-client");
  expect(world.main[0].headers.get("x-openwork-host-token")).toBe("fixture-host");
  await client.listUserEnvKeys();
  expect(world.renderer).toHaveLength(1);
  expect(world.main).toHaveLength(1);
});
