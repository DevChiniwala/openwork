import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appSmokeWorld } from "../worlds/first-run.ts";

const test = spec.world(appSmokeWorld);

/** The engine wraps lists in `{ data }`; older shapes answered with the bare list. */
function engineItems(body: unknown): unknown {
  if (body !== null && typeof body === "object" && !Array.isArray(body) && "data" in body) {
    const data: unknown = body.data;
    if (data !== null && typeof data === "object" && !Array.isArray(data) && "items" in data) return data.items;
    return data;
  }
  return body;
}

test("app boots with a control route and meaningful visible content", async ({ world, user, probe, evidence, step }) => {
  const route = await probe.hash();
  const visibleTextLength = (await probe.text()).trim().length;
  expect(route).toBeTruthy();
  expect(visibleTextLength).toBeGreaterThan(40);
  evidence.recordAssertionEvidence(
    "The app boots on a non-empty control route with rendered text",
    JSON.stringify({ route, visibleTextLength, minimumTextLength: 40 }),
    Boolean(route) && visibleTextLength > 40,
  );
  if (world.packaged) {
    await probe.eventually(() => probe.hash(), {
      within: 30_000,
      label: "packaged startup selects its empty workspace route",
      until: (hash) => /^#\/workspace\/[^/]+\/session$/.test(hash),
    });
    await user.see("composer", { editable: true, text: "" });
    const expectedRuntime = {
      bridge: true, protocol: "file:", health: 200, emptySession: true, signedOut: true, onboarding: false, crash: false,
    };
    // The renderer can remount while the asynchronous IPC/health probe runs.
    // Wait for one coherent ready snapshot instead of combining observations
    // from different startup frames. Keep every positive and negative condition.
    const runtime = await probe.eventually(() => world.packagedRuntime(), {
      within: 30_000,
      label: "packaged renderer, bridge and server are ready together",
      until: (value) => typeof value === "object" && value !== null
        && Object.entries(expectedRuntime).every(([key, expected]) => Reflect.get(value, key) === expected),
    });
    expect(runtime).toEqual(expectedRuntime);
    await user.see("composer", { editable: true, text: "" });
    await user.see("Run task");
    const workspaceId = /^#\/workspace\/([^/]+)\/session$/.exec(await probe.hash())?.[1];
    if (!workspaceId) throw new Error("The packaged app did not open its empty workspace route.");
    const sessions = await probe.desktopApi(`/workspace/${workspaceId}/opencode2/api/session`);
    expect(sessions.status).toBe(200);
    const sessionItems = engineItems(sessions.body);
    expect(sessionItems).toEqual([]);
    const engine = await world.packagedEngineInfo();
    expect(engine.version).toMatch(/^2\./);
    evidence.recordAssertionEvidence(
      "The packaged app starts signed out on an empty workspace served by OpenCode v2",
      JSON.stringify({ runtime, sessionsStatus: sessions.status, sessions: engineItems(sessions.body), engineVersion: engine.version }),
      typeof runtime === "object" && runtime !== null
        && Object.entries(expectedRuntime).every(([key, expected]) => Reflect.get(runtime, key) === expected)
        && sessions.status === 200
        && Array.isArray(sessionItems) && sessionItems.length === 0
        && /^2\./.test(engine.version),
    );
  } else {
    await step("The workspace opens with an editable composer and no crash message", async () => {
      const workspaceId = world.workspace?.workspaceId;
      expect(workspaceId).toBeTruthy();
      // Readiness and crash absence are deterministic checks, not deferred vision judgments.
      await user.press("Escape");
      await user.see("composer", { editable: true, text: "" });
      await user.see("Run task");
      const text = await probe.text();
      const crashMessage = /Something went wrong|Application error|Cannot find module|Maximum update depth exceeded/i.exec(text)?.[0] ?? null;
      expect(crashMessage).toBeNull();
      evidence.recordAssertionEvidence(
        "The workspace has an empty editable composer and no crash message",
        JSON.stringify({ workspaceId, composer: { editable: true, text: "" }, runTaskVisible: true, crashMessage }),
        Boolean(workspaceId) && crashMessage === null,
      );
      await user.screenshot();
    });
  }
});
