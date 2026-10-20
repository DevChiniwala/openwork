import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sessionDebug } from "../worlds/session-debug.ts";

const test = spec.world(sessionDebug, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: [] },
  needs: { commands: ["bun"] },
});

test("a developer can inspect, move, resize and dismiss session diagnostics without leaving the conversation", async ({ world, user, probe, step, evidence }) => {
  const panel = '[data-testid="session-debug-panel"]';
  const rect = async () => (await probe.dom(panel)).elements[0]!.rect;

  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("before: conversation diagnostics stay hidden until developer mode is enabled", async () => {
    await user.see("composer");
    await user.notSee({ testId: "session-debug-panel" });
    const count = (await probe.dom(panel)).elements.length;
    expect(count).toBe(0);
    evidence.recordAssertionEvidence("Normal conversations have no debug overlay", `debug panels=${count}`, count === 0);
    await user.screenshot();
  });

  await step("after: developer mode shows versions, waiting state and measured connection health", async () => {
    await user.press(world.paletteShortcut);
    await user.see({ role: "combobox" });
    await user.type({ role: "combobox" }, "Enable Developer Mode");
    await user.click({ text: "Enable Developer Mode" });
    await user.see({ testId: "session-debug-panel" });
    await user.see({ text: /^Connected$/ }, { timeoutMs: 20_000 });
    const text = (await probe.dom(panel)).elements[0]?.text ?? "";
    expect(text).toContain("Waiting on");
    expect(text).toContain("OpenCode");
    expect(text).toMatch(/Health RTT \d+ ms/);
    expect(text).not.toContain("Intended session");
    evidence.recordAssertionEvidence("Compact diagnostics use real health responses", text, /Health RTT \d+ ms/.test(text));
    await user.screenshot();
  });

  await step("the panel moves and resizes using its keyboard-accessible handles", async () => {
    const before = await rect();
    await user.click({ role: "button", label: "Move session debug" });
    await user.press("ArrowLeft");
    await user.press("ArrowUp");
    await user.click({ role: "button", label: "Resize session debug" });
    await user.press("ArrowRight");
    await user.press("ArrowDown");
    const after = await rect();
    expect(after.left).toBe(before.left - 10);
    expect(after.top).toBe(before.top - 10);
    expect(after.width).toBe(before.width + 10);
    expect(after.height).toBe(before.height + 10);
    await user.click({ role: "button", label: "More details" });
    await user.see({ text: "Intended session" });
    evidence.recordAssertionEvidence("Move, resize and details work in the conversation", `before=${JSON.stringify(before)}; after=${JSON.stringify(after)}`, after.width > before.width && after.left < before.left);
    await user.screenshot();
  });

  await step("dismissal is reversible and resizing the viewport keeps the controls reachable", async () => {
    await user.click({ role: "button", label: "Dismiss session debug" });
    await user.notSee({ testId: "session-debug-panel" });
    await user.see("composer");
    await user.click({ role: "button", label: "Show session debug" });
    await user.resizeViewport({ width: 640, height: 480, deviceScaleFactor: 1 });
    const bounds = await probe.eventually(rect, { within: 5_000, label: "debug panel stays in the smaller viewport", until: value => value.right <= 640 && value.bottom <= 480 });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    await user.see({ role: "button", label: "Dismiss session debug" });
    evidence.recordAssertionEvidence("Reopening retains a usable panel on a smaller window", JSON.stringify(bounds), bounds.right <= 640 && bounds.bottom <= 480);
    await user.screenshot();
  });
});
