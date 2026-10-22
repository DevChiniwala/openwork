/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { EngineV2PreviewStatus } from "../src/app/lib/openwork-server";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
// Base UI chooses its layout-effect shim at import time; portals need the DOM first.
const { createDenClient } = await import("../src/app/lib/den");
const server = await import("../src/app/lib/openwork-server");
const { isDesktopRuntime } = await import("../src/app/lib/runtime-env");
const automations = await import("../src/react-app/domains/automations/use-automations");
const connection = await import("../src/react-app/shell/openwork-connection");
const den = await import("../src/app/lib/den");
const { EngineMigrationOverlay, observeEngineMigration, requestEngineMigration, resetEngineMigrationForTest, useEngineMigrationStore } = await import("../src/react-app/shell/engine-migration");
const { useOpencodeEngineControls } = await import("../src/react-app/shell/opencode-engine-controls");
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | null = null;
let queryClient: QueryClient;
let previousBridge: unknown;

const status: EngineV2PreviewStatus = {
  enabled: false, running: false, chatRouting: false, v1HistoryAvailable: true,
  mirroredProviderIds: [], skippedProviderIds: [], catalogModelIds: [],
  migration: { state: "idle", imported: 0, skipped: 0, total: 2 },
};
const orgId = "org_test";

beforeEach(() => {
  previousBridge = window.__OPENWORK_ELECTRON__;
  Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__");
  resetEngineMigrationForTest();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  // This is the same cache entry populated by Calendar and other org-feature consumers.
  queryClient.setQueryData(["den", "org-features", orgId], { engineV2ForceUpgrade: true });
  spyOn(automations, "useAutomationsDenContext").mockReturnValue({
    client: createDenClient({ baseUrl: "https://den.example.test", token: "test-token" }),
    organizationId: orgId, ready: true, queryRoot: ["den", "automations", orgId],
  });
  spyOn(connection, "resolveOpenworkConnection").mockResolvedValue({
    normalizedBaseUrl: "http://localhost:8787", resolvedToken: "test-token", resolvedHostToken: "test-host",
    hostInfo: null, source: "stored-settings",
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  queryClient.clear();
  resetEngineMigrationForTest();
  Reflect.set(window, "__OPENWORK_ELECTRON__", previousBridge);
  document.body.innerHTML = "";
  mock.restore();
});

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function engineClient() {
  const client = server.createOpenworkServerClient({ baseUrl: "http://localhost:8787", token: "test-token" });
  spyOn(client, "getEngineV2PreviewStatus").mockResolvedValue(status);
  spyOn(client, "setEngineV2ForcePolicy").mockResolvedValue(status);
  spyOn(client, "migrateOpencodeHistory").mockResolvedValue(status);
  spyOn(client, "getEngineActivity").mockResolvedValue({
    v1: { verdict: "idle", busySessions: 0, waitingRequests: 0 }, v2: null,
  });
  spyOn(client, "switchOpencodeEngine").mockResolvedValue({ ...status, enabled: true, chatRouting: true });
  spyOn(server, "createOpenworkServerClient").mockReturnValue(client);
  return client;
}

async function renderOverlay() {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<QueryClientProvider client={queryClient}><EngineMigrationOverlay discoverRunningMigration={false} /></QueryClientProvider>);
  });
}

test("web never upgrades the engine from another consumer's enabled feature cache", async () => {
  const client = engineClient();
  expect(isDesktopRuntime()).toBe(false);
  await renderOverlay();
  expect(queryClient.getQueryData(["den", "org-features", orgId])).toEqual({ engineV2ForceUpgrade: true });
  expect(document.querySelector('[data-testid="engine-migration-consent"]')).toBeNull();
  // A render-only guard is insufficient: the feature hook must not start engine reads on web either.
  expect(connection.resolveOpenworkConnection).not.toHaveBeenCalled();
  expect(client.getEngineV2PreviewStatus).not.toHaveBeenCalled();
  expect(client.setEngineV2ForcePolicy).not.toHaveBeenCalled();
});

test("web palette omits the hidden engine settings destination, desktop retains it", async () => {
  const { buildCommandPaletteSettingsItems } = await import("../src/react-app/shell/command-palette-settings");
  const input = { developerMode: false, capabilities: { autoUpdate: false }, onOpenSettings: () => {}, onOpenExtensions: () => {} };
  expect(buildCommandPaletteSettingsItems(input).some(item => item.id === "settings:advanced/experimental-engine")).toBe(false);
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  expect(buildCommandPaletteSettingsItems(input).some(item => item.id === "settings:advanced/experimental-engine")).toBe(true);
});

test("desktop with the upgrade off still opens consent for a manual upgrade", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  await setFeatures(false);
  await renderOverlay();
  expect(document.body.textContent).toBe("");
  await act(async () => requestEngineMigration(client, "upgrade"));
  expect(document.querySelector('[data-testid="engine-migration-consent"]')?.getAttribute("data-mode")).toBe("upgrade");
  expect(client.migrateOpencodeHistory).not.toHaveBeenCalled();
});

test("web hides consent and engine-switch prompts already in the shared store", async () => {
  const client = engineClient();
  useEngineMigrationStore.setState({
    consent: { client, mode: "upgrade", runningTasks: 0, submitting: false, error: null },
    switchPrompt: { engine: "v2", from: "v1", runningTasks: 1, resolve: () => {} },
  });
  await renderOverlay();
  expect(document.querySelector('[data-testid="engine-migration-consent"]')).toBeNull();
  expect(document.querySelector('[data-testid="engine-switch-prompt"]')).toBeNull();
});

for (const view of ["dialog", "banner"] satisfies Array<"dialog" | "banner">) {
  test(`web hides stored migration ${view} and does not poll it`, async () => {
    const client = engineClient();
    useEngineMigrationStore.setState({ progress: {
      client, migration: { state: "running", phase: "copying", imported: 1, skipped: 0, total: 2 },
      selected: "v1", view, retrying: false, runningTasks: 0, switchWhenDone: true,
    } });
    await renderOverlay();
    expect(document.querySelector('[data-testid="engine-migration-progress"]')).toBeNull();
    expect(document.querySelector('[data-testid="engine-migration-banner"]')).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });
    expect(client.getEngineV2PreviewStatus).not.toHaveBeenCalled();
  });
}

test("web does not finish an upgrade from stored completed progress", async () => {
  const client = engineClient();
  useEngineMigrationStore.setState({ progress: {
    client, migration: { state: "completed", imported: 2, skipped: 0, total: 2 },
    selected: "v1", view: "banner", retrying: false, runningTasks: 0, switchWhenDone: true,
  } });
  await renderOverlay();
  expect(client.switchOpencodeEngine).not.toHaveBeenCalled();
  expect(client.getEngineActivity).not.toHaveBeenCalled();
});

test("web settings and palette controls ignore migration progress from the shared store", async () => {
  const client = engineClient();
  useEngineMigrationStore.setState({ progress: {
    client, migration: { state: "running", imported: 1, skipped: 0, total: 2 },
    selected: "v1", view: "banner", retrying: false, runningTasks: 0, switchWhenDone: false,
  } });
  function Controls() {
    const engine = useOpencodeEngineControls(client);
    return <div data-migrating={engine.migrating} data-disabled={engine.disabled}>{engine.message}</div>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root?.render(<Controls />); });
  expect(host.firstElementChild?.getAttribute("data-migrating")).toBe("false");
  expect(host.firstElementChild?.getAttribute("data-disabled")).toBe("true");
  expect(host.textContent).toBe("");
  expect(client.getEngineV2PreviewStatus).not.toHaveBeenCalled();
});

for (const desktop of [false, true]) {
  test(`${desktop ? "desktop retains" : "web omits"} engine switching and migration palette actions`, async () => {
    if (desktop) Reflect.set(window, "__OPENWORK_ELECTRON__", {});
    const client = engineClient();
    const observed: { actions: string[] | null } = { actions: null };
    function Controls() {
      const engine = useOpencodeEngineControls(client);
      observed.actions = engine.items.map((item) => item.id);
      return <div>{engine.items.map((item) => <button key={item.id}>{item.title}</button>)}</div>;
    }
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root?.render(<Controls />); });
    expect(observed.actions).toEqual(desktop
      ? ["opencode.switch-v1", "opencode.switch-v2", "opencode.migrate-v2"] : []);
    expect(host.querySelectorAll("button").length).toBe(desktop ? 3 : 0);
    if (!desktop) expect(client.getEngineV2PreviewStatus).not.toHaveBeenCalled();
  });
}

test("web omits the Advanced engine section entirely", async () => {
  const { AdvancedEngineV2PreviewSection } = await import("../src/react-app/domains/settings/pages/advanced-view-sections");
  const client = engineClient();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root?.render(<AdvancedEngineV2PreviewSection client={client} />); });
  expect(host.innerHTML).toBe("");
  expect(client.getEngineV2PreviewStatus).not.toHaveBeenCalled();
});

async function setFeatures(upgrade: boolean) {
  await act(async () => {
    queryClient.setQueryData(["den", "org-features", orgId], { engineV2ForceUpgrade: upgrade });
    // TanStack observer notifications are scheduled, not synchronous with cache writes.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("desktop forwards the off upgrade flag without starting a migration", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  await setFeatures(false);
  await renderOverlay();
  expect(client.setEngineV2ForcePolicy).toHaveBeenCalledWith({ upgrade: false });
  expect(client.migrateOpencodeHistory).not.toHaveBeenCalled();
  expect(client.switchOpencodeEngine).not.toHaveBeenCalled();
});

for (const upgrade of [false, true]) {
  test(`web ignores the cached force flag (upgrade=${upgrade})`, async () => {
    const client = engineClient();
    await setFeatures(upgrade);
    await renderOverlay();
    expect(connection.resolveOpenworkConnection).not.toHaveBeenCalled();
    expect(client.setEngineV2ForcePolicy).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe("");
  });
}

test("pending force upgrade shows only a banner before ownership moves, without renderer migration or switching", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  const forced: EngineV2PreviewStatus = {
    ...status, engineOrigin: "manual", engineForced: false, forceUpgradePending: true,
    migration: { state: "running", phase: "copying", imported: 1, skipped: 0, total: 2 },
  };
  spyOn(client, "setEngineV2ForcePolicy").mockResolvedValue(forced);
  spyOn(client, "getEngineV2PreviewStatus").mockResolvedValue(forced);
  await setFeatures(true);
  await renderOverlay();
  expect(client.setEngineV2ForcePolicy).toHaveBeenCalledWith({ upgrade: true });
  expect(document.querySelector('[data-testid="engine-migration-banner"]')).not.toBeNull();
  expect(document.querySelector('[data-testid="engine-migration-consent"]')).toBeNull();
  expect(document.querySelector('[data-testid="engine-migration-progress"]')).toBeNull();
  expect(useEngineMigrationStore.getState().progress?.serverManaged).toBe(true);
  expect(client.migrateOpencodeHistory).not.toHaveBeenCalled();
  expect(client.switchOpencodeEngine).not.toHaveBeenCalled();
});

for (const origin of ["forced", "manual"] satisfies Array<"forced" | "manual">) {
  test(`off policy ${origin === "forced" ? "observes the host's forced-only revert" : "leaves manual engine selection alone"}`, async () => {
    Reflect.set(window, "__OPENWORK_ELECTRON__", {});
    const client = engineClient();
    spyOn(client, "setEngineV2ForcePolicy").mockResolvedValue({
      ...status, enabled: true, running: true, chatRouting: true,
      engineOrigin: origin, engineForced: origin === "forced",
    });
    spyOn(client, "getEngineV2PreviewStatus").mockResolvedValue({
      ...status, engineOrigin: "reverted", engineForced: false,
    });
    const changed = mock(() => {});
    window.addEventListener("openwork-engine-changed", changed);
    try {
      await setFeatures(false);
      await renderOverlay();
      expect(client.setEngineV2ForcePolicy).toHaveBeenCalledWith({ upgrade: false });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });
      expect(client.getEngineV2PreviewStatus).toHaveBeenCalledTimes(origin === "forced" ? 1 : 0);
      expect(changed).toHaveBeenCalledTimes(origin === "forced" ? 2 : 0);
      expect(client.switchOpencodeEngine).not.toHaveBeenCalled();
      expect(client.migrateOpencodeHistory).not.toHaveBeenCalled();
      expect(document.body.textContent).toBe("");
    } finally {
      window.removeEventListener("openwork-engine-changed", changed);
    }
  });
}

test("upgrade turning off is forwarded for host-owned revert", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  await setFeatures(true);
  await renderOverlay();
  expect(client.setEngineV2ForcePolicy).toHaveBeenLastCalledWith({ upgrade: true });
  await setFeatures(false);
  expect(client.setEngineV2ForcePolicy).toHaveBeenLastCalledWith({ upgrade: false });
  expect(client.switchOpencodeEngine).not.toHaveBeenCalled();
  expect(client.migrateOpencodeHistory).not.toHaveBeenCalled();
});

for (const state of ["completed", "error"] satisfies Array<"completed" | "error">) {
  test(`forced ${state} never opens recovery consent or switches from the renderer`, async () => {
    Reflect.set(window, "__OPENWORK_ELECTRON__", {});
    const client = engineClient();
    await setFeatures(true);
    useEngineMigrationStore.setState({ progress: {
      client, migration: { state: "running", imported: 1, skipped: 0, total: 2 },
      selected: "v1", view: "dialog", retrying: false, runningTasks: 0, switchWhenDone: true,
    } });
    observeEngineMigration(client, {
      ...status, engineOrigin: "manual", engineForced: false, forceUpgradePending: true,
      migration: { state, imported: state === "completed" ? 2 : 1, skipped: 0, total: 2 },
    });
    expect(useEngineMigrationStore.getState().progress).toMatchObject({
      serverManaged: true, switchWhenDone: false, view: "banner",
    });
    await renderOverlay();
    expect(document.querySelector('[data-testid="engine-migration-progress"]')).toBeNull();
    expect(document.querySelector('[data-testid="engine-migration-consent"]')).toBeNull();
    expect(client.switchOpencodeEngine).not.toHaveBeenCalled();
    expect(client.migrateOpencodeHistory).not.toHaveBeenCalled();
    expect(useEngineMigrationStore.getState().progress).toBeNull();
  });
}

test("a fresh forced v2 status refreshes routing without any migration UI or renderer switch", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  spyOn(client, "setEngineV2ForcePolicy").mockResolvedValue({
    ...status, enabled: true, running: true, chatRouting: true,
    v1HistoryAvailable: false, engineOrigin: "forced", engineForced: true,
  });
  const changed = mock(() => {});
  window.addEventListener("openwork-engine-changed", changed);
  try {
    await setFeatures(true);
    await renderOverlay();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toBe("");
    expect(client.migrateOpencodeHistory).not.toHaveBeenCalled();
    expect(client.switchOpencodeEngine).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("openwork-engine-changed", changed);
  }
});

test("signed-out desktop follows the deployment switch, never cached organization flags", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  spyOn(automations, "useAutomationsDenContext").mockReturnValue({
    client: null, organizationId: orgId, ready: false, queryRoot: ["den", "automations", orgId],
  });
  const getDeploymentFeatures = mock(async () => ({ engineV2ForceUpgrade: false }));
  spyOn(den, "createDenClient").mockReturnValue({ getDeploymentFeatures } as unknown as ReturnType<typeof den.createDenClient>);
  await setFeatures(true);
  await renderOverlay();
  for (let tick = 0; tick < 50 && !client.setEngineV2ForcePolicy.mock.calls.length; tick++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(getDeploymentFeatures).toHaveBeenCalled();
  // The deployment's off switch reaches signed-out desktops; the cached org "on" does not.
  expect(client.setEngineV2ForcePolicy).toHaveBeenCalledWith({ upgrade: false });
  expect(client.migrateOpencodeHistory).not.toHaveBeenCalled();
});

test("signed-out desktop sends nothing when Den is unreachable", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  spyOn(automations, "useAutomationsDenContext").mockReturnValue({
    client: null, organizationId: orgId, ready: false, queryRoot: ["den", "automations", orgId],
  });
  spyOn(den, "createDenClient").mockReturnValue({ getDeploymentFeatures: mock(async () => { throw new Error("offline"); }) } as unknown as ReturnType<typeof den.createDenClient>);
  await renderOverlay();
  for (let tick = 0; tick < 20; tick++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(client.setEngineV2ForcePolicy).not.toHaveBeenCalled();
});

test("a failed force request never falls back to a renderer migration, switch, or consent", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  spyOn(client, "setEngineV2ForcePolicy").mockRejectedValue(new Error("Host unavailable"));
  await setFeatures(true);
  await renderOverlay();
  expect(client.setEngineV2ForcePolicy).toHaveBeenCalledTimes(1);
  expect(client.migrateOpencodeHistory).not.toHaveBeenCalled();
  expect(client.switchOpencodeEngine).not.toHaveBeenCalled();
  expect(document.body.textContent).toBe("");
});

test("a newer off policy waits for an in-flight upgrade policy and discards its stale progress", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  const pending = Promise.withResolvers<EngineV2PreviewStatus>();
  const policy = spyOn(client, "setEngineV2ForcePolicy")
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue(status);
  await setFeatures(true);
  await renderOverlay();
  expect(policy).toHaveBeenCalledTimes(1);
  await setFeatures(false);
  expect(policy).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({
    ...status, engineOrigin: "forced", engineForced: true,
    migration: { state: "running", imported: 1, skipped: 0, total: 2 },
  }));
  expect(policy).toHaveBeenLastCalledWith({ upgrade: false });
  expect(policy).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[data-testid="engine-migration-banner"]')).toBeNull();
});

test("enabling the upgrade removes a manual upgrade consent without confirming it", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  useEngineMigrationStore.setState({ consent: {
    client, mode: "upgrade", runningTasks: 0, submitting: false, error: null,
  } });
  await setFeatures(true);
  await renderOverlay();
  expect(useEngineMigrationStore.getState().consent).toBeNull();
  expect(document.querySelector('[data-testid="engine-migration-consent"]')).toBeNull();
  expect(client.migrateOpencodeHistory).not.toHaveBeenCalled();
});

test("force API sends host authentication and parses ownership fields without inferring missing markers", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    ...status, engineOrigin: "manual", engineForced: false, forceUpgradePending: true,
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  const client = server.createOpenworkServerClient({ baseUrl: "http://localhost:8787", token: "test-token", hostToken: "test-host" });
  const result = await client.setEngineV2ForcePolicy({ upgrade: true });
  expect(result.engineOrigin).toBe("manual");
  expect(result.engineForced).toBe(false);
  expect(result.forceUpgradePending).toBe(true);
  const [url, options] = fetch.mock.calls[0] ?? [];
  expect(url).toBe("http://localhost:8787/experimental/engine-v2-preview/force");
  expect(options?.method).toBe("POST");
  expect(new Headers(options?.headers).get("X-OpenWork-Host-Token")).toBe("test-host");
  expect(options?.body).toBe(JSON.stringify({ upgrade: true }));
  fetch.mockResolvedValue(new Response(JSON.stringify(status), { status: 200 }));
  const legacy = await client.getEngineV2PreviewStatus();
  expect(legacy.engineOrigin).toBeUndefined();
  expect(legacy.engineForced).toBeUndefined();
  expect(legacy.forceUpgradePending).toBeUndefined();
});
