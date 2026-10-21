import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { computerWindowApproval } from "../worlds/computer-window-approval.ts";

const test = spec.world(computerWindowApproval, { timeout: 90_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("enabled computer access continues without approval and preserves human handoff", async ({ world, user, probe, step, evidence }) => {
  await step("before: enabled access opens the requested window directly", async () => {
    await user.see({ testId: "session-computer-floating" });
    await user.notSee({ role: "button", label: "Allow this window" });
    await user.see({ role: "button", label: "Take over" });
    expect(world.decisions()).toEqual([]);
    evidence.recordAssertionEvidence("Enabled access needs no approval", "The production broker and remote adapter opened the requested target without a UI decision.", world.decisions().length === 0);
    await user.screenshot();
  });
  await step("follow-up: technical cleanup reopens directly", async () => {
    await world.followUp();
    await probe.eventually(world.snapshot, { within: 3000, until: value => value.session?.state === "active", label: "the follow-up silently renews its internal session" });
    await user.notSee({ role: "button", label: "Allow this window" });
    expect(world.decisions()).toEqual([]);
  });
  await step("after: takeover stays paused across cleanup until Continue", async () => {
    await user.click({ role: "button", label: "Take over" });
    await user.see({ role: "button", label: "Continue" });
    await world.followUp();
    await probe.eventually(world.snapshot, { within: 3000, until: value => value.session === null, label: "the paused technical session is released" });
    await user.see({ role: "button", label: "Continue" });
    expect(world.inputs()).toBe(0);
    await user.screenshot();
    await user.click({ role: "button", label: "Continue" });
    await world.followUp();
    await user.see({ role: "button", label: "Take over" });
    expect(world.inputs()).toBe(0);
    evidence.recordAssertionEvidence("Only Continue returns control", "Human takeover survived cleanup. Continue allowed fresh work without replaying an action.", world.inputs() === 0);
  });
  await step("Stop ends the current work", async () => {
    await user.click({ role: "button", label: "Stop" });
    await user.see({ text: "Current work stopped" });
    expect((await world.snapshot()).enabled).toBe(false);
    expect(world.decisions().map(value => Reflect.get(Object(value), "action"))).toEqual(["takeover", "resume"]);
  });
});
