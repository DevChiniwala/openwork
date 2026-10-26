/** @jsxImportSource react */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";

import type { OpenworkControlAPI, OpenworkControlAction } from "../src/react-app/shell/control/control-provider";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
// Base UI picks its layout-effect shim at module load, so the app must be
// imported after the DOM exists or the dialog portal never mounts.
const [
  { isWorkingStatus, listControlSessions },
  { OpenworkControlProvider, useControlAction },
] = await Promise.all([
  import("../src/react-app/domains/session/control/list-control-sessions"),
  import("../src/react-app/shell/control/control-provider"),
]);
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

describe("session.list_sessions exposes live activity", () => {
  test("entries carry status and working from the same source as the sidebar", () => {
    const listed = listControlSessions({}, {
      workspaces: [{ id: "ws", name: "Main" }],
      sessionsByWorkspaceId: { ws: [
        { id: "busy", title: "Busy", time: { updated: 3 } },
        { id: "asks", title: "Asks", time: { updated: 2 } },
        { id: "done", title: "Done", time: { updated: 1 } },
        { id: "failed", title: "Failed", time: { updated: 0 } },
      ] },
      pinnedIds: [],
      statusFor: (_workspaceId, sessionId) => (
        sessionId === "busy" ? "responding" : sessionId === "asks" ? "waiting" : sessionId === "failed" ? "error" : "idle"
      ),
    });
    expect(listed.map(({ sessionId, status, working }) => ({ sessionId, status, working }))).toEqual([
      { sessionId: "busy", status: "responding", working: true },
      { sessionId: "asks", status: "waiting", working: true },
      { sessionId: "done", status: "idle", working: false },
      { sessionId: "failed", status: "error", working: false },
    ]);
  });

  test("entries carry the session's bound model and reasoning effort from the engine record", () => {
    const listed = listControlSessions({}, {
      workspaces: [{ id: "ws", name: "Main" }],
      sessionsByWorkspaceId: { ws: [
        // The engine writes {id, providerID, variant}; agents read {providerId, modelId, variant}.
        { id: "high", title: "High", time: { updated: 4 }, model: { id: "claude-fable-5-1", providerID: "lpr_test", variant: "high" } },
        { id: "default", title: "Default", time: { updated: 3 }, model: { id: "gpt-6-astra", providerID: "openai", variant: "default" } },
        { id: "unbound", title: "Unbound", time: { updated: 2 } },
        { id: "partial", title: "Partial", time: { updated: 1 }, model: { providerID: "openai" } },
      ] },
      pinnedIds: [],
      statusFor: () => "idle",
    });
    expect(listed.map(({ sessionId, model }) => ({ sessionId, model }))).toEqual([
      { sessionId: "high", model: { providerId: "lpr_test", modelId: "claude-fable-5-1", variant: "high" } },
      { sessionId: "default", model: { providerId: "openai", modelId: "gpt-6-astra", variant: null } },
      { sessionId: "unbound", model: null },
      { sessionId: "partial", model: null },
    ]);
  });

  test("only finished or failed turns count as not working", () => {
    expect(["thinking", "responding", "waiting", "compacting"].map(isWorkingStatus)).toEqual([true, true, true, true]);
    expect(["idle", "error"].map(isWorkingStatus)).toEqual([false, false]);
  });
});

describe("control bridge contract: channel and structured codes", () => {
  async function mountAction(action: OpenworkControlAction): Promise<OpenworkControlAPI> {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    function Register() {
      useControlAction(action);
      return null;
    }
    await act(async () => root.render(
      <MemoryRouter><OpenworkControlProvider><Register /></OpenworkControlProvider></MemoryRouter>,
    ));
    cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
    const api = window.__openworkControl;
    if (!api) throw new Error("control API was not published");
    return api;
  }

  test("actions learn whether an agent bridge or the window issued the command", async () => {
    const seen: boolean[] = [];
    const api = await mountAction({
      id: "test.channel",
      label: "Channel",
      sideEffect: "mutation",
      execute: (_args, helpers) => { seen.push(helpers.bridged); return { ok: true }; },
    });
    await act(async () => {
      expect(await api.command({ id: "test.channel", origin: { sessionId: "ses_requester" } })).toMatchObject({ ok: true });
      expect(await api.execute("test.channel")).toMatchObject({ ok: true });
    });
    expect(seen).toEqual([true, false]);
  });

  test("an action's structured code and hint reach the bridge unchanged", async () => {
    const api = await mountAction({
      id: "test.coded",
      label: "Coded",
      sideEffect: "mutation",
      execute: () => ({ ok: false, code: "target_working", error: "Busy elsewhere.", hint: "Stop it first." }),
    });
    await act(async () => {
      expect(await api.command({ id: "test.coded", origin: { sessionId: "ses_requester" } })).toMatchObject({
        ok: false,
        code: "target_working",
        error: "Busy elsewhere.",
        hint: "Stop it first.",
      });
      expect(await api.execute("test.coded")).toMatchObject({ ok: false, code: "target_working", hint: "Stop it first." });
    });
  });

  test("unknown codes fall back to failed so the schema stays closed", async () => {
    const api = await mountAction({
      id: "test.odd",
      label: "Odd",
      sideEffect: "mutation",
      execute: () => ({ ok: false, code: "made_up", error: "Nope." }),
    });
    await act(async () => {
      expect(await api.command({ id: "test.odd" })).toMatchObject({ ok: false, code: "failed", error: "Nope." });
    });
  });
});
