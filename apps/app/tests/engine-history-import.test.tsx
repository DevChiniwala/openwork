/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { EngineV2MigrationStatus, EngineV2PreviewStatus } from "../src/app/lib/openwork-server";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
// Base UI chooses its layout-effect shim at import time; render after the DOM exists.
const { CHAT_HISTORY_IMPORTED_EVENT, EngineMigrationOverlay, historyImportView } = await import("../src/react-app/shell/engine-migration");
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | null = null;
let previousBridge: unknown;

const idle: EngineV2MigrationStatus = { state: "idle", imported: 0, skipped: 0, total: 0 };
function status(patch: Partial<EngineV2PreviewStatus>): EngineV2PreviewStatus {
  return {
    enabled: true, running: true, chatRouting: true,
    mirroredProviderIds: [], skippedProviderIds: [], catalogModelIds: [],
    migration: idle,
    ...patch,
  };
}

beforeEach(() => {
  previousBridge = window.__OPENWORK_ELECTRON__;
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  Reflect.set(window, "__OPENWORK_ELECTRON__", previousBridge);
  document.body.innerHTML = "";
});

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function fakeClient(statuses: EngineV2PreviewStatus[], retried: EngineV2PreviewStatus = status({})) {
  let reads = 0;
  let current = statuses;
  const calls = { migrate: 0 };
  const client = {
    getEngineV2PreviewStatus: async () => current[Math.min(reads++, current.length - 1)],
    migrateOpencodeHistory: async () => {
      calls.migrate += 1;
      // The host restarts the copy; later reads report it.
      current = [retried];
      reads = 0;
      return retried;
    },
  };
  return { client, calls };
}

async function render(client: ReturnType<typeof fakeClient>["client"]) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<EngineMigrationOverlay resolveClient={async () => client} />);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("copying is pending until the host clears it, and only a failed copy offers a retry", () => {
  expect(historyImportView(status({ historyImportPending: true, migration: idle })).kind).toBe("copying");
  expect(historyImportView(status({ migration: { ...idle, state: "running" } })).kind).toBe("copying");
  expect(historyImportView(status({ migration: { ...idle, state: "error", error: "disk full" } })).kind).toBe("error");
  expect(historyImportView(status({ migration: { ...idle, state: "completed" } })).kind).toBe("idle");
  expect(historyImportView(status({ migration: undefined })).kind).toBe("idle");
});

test("shows a non-blocking banner while copying and reloads chat lists once it finishes", async () => {
  const copying = status({ historyImportPending: true, migration: { state: "running", phase: "copying", imported: 1, skipped: 0, total: 4 } });
  const done = status({ migration: { state: "completed", imported: 4, skipped: 0, total: 4 } });
  const { client } = fakeClient([copying, done]);
  let imported = 0;
  const onImported = () => { imported += 1; };
  window.addEventListener(CHAT_HISTORY_IMPORTED_EVENT, onImported);
  try {
    await render(client);
    const banner = document.querySelector('[data-testid="engine-migration-banner"]');
    expect(banner?.getAttribute("role")).toBe("status");
    expect(banner?.textContent).toContain("1 of 4 chats copied");
    await waitFor(() => imported === 1, "the copy to finish");
    expect(document.querySelector('[data-testid="engine-migration-banner"]')).toBeNull();
  } finally {
    window.removeEventListener(CHAT_HISTORY_IMPORTED_EVENT, onImported);
  }
});

test("a failed copy shows a retryable notice that asks the host to try again", async () => {
  const failed = status({ migration: { ...idle, state: "error", error: "disk full", startedAt: "2026-10-26T00:00:00Z" } });
  const running = status({ historyImportPending: true, migration: { ...idle, state: "running" } });
  const { client, calls } = fakeClient([failed], running);
  await render(client);
  const notice = document.querySelector('[data-testid="engine-migration-error"]');
  expect(notice).not.toBeNull();
  const retry = [...(notice?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Try again");
  if (!retry) throw new Error("Missing Try again");
  await act(async () => { retry.click(); });
  expect(calls.migrate).toBe(1);
  expect(document.querySelector('[data-testid="engine-migration-banner"]')).not.toBeNull();
});

test("the web runtime never observes the local host's copy", async () => {
  Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__");
  const { client } = fakeClient([status({ historyImportPending: true })]);
  await render(client);
  expect(document.querySelector('[data-testid="engine-migration-banner"]')).toBeNull();
});
