import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { workbotUsageRecovery } from "../worlds/workbot-usage-recovery.ts";

// Standalone Workbot uses direct Chrome, not seed.web (the Den dashboard).
const test = spec.world(workbotUsageRecovery, { timeout: 90_000, needs: { placement: "local" }, resources: { surfaces: [], services: ["mock"] } });

test("a signed-in member can recover from a model limit without losing the conversation", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("before: a used-up free allowance looks like an unreachable model", async () => {
    await user.see({ text: "I couldn't reach the AI model just now." });
    await user.see({ text: "Keep our earlier work" });
    await user.notSee({ role: "link", label: /^Upgrade models/ });
    const witness = world.witness("free");
    evidence.recordAssertionEvidence("The real model request hit a hard free limit once", `Model attempts=${witness.attempts}; automatic retry offered=${witness.retryable}`, witness.attempts === 1 && witness.retryable === false);
    expect(witness).toEqual({ attempts: 1, retryable: false });
    await user.screenshot();
  });
  await step("after: an authorized member sees the reset time and an upgrade in the same workspace", async () => {
    await user.navigate(`${world.url}?recovery=on`);
    await user.see({ text: /You've used the free model allowance for now/ });
    await user.see({ text: /It resets/ });
    await user.see({ role: "link", label: /^Upgrade models/ });
    await user.notSee({ text: /Sign in for/ });
    await user.type({ role: "textbox", label: "Message Workbot" }, "Keep this draft");
    await user.click({ role: "button", label: "Check access" });
    await user.notSee({ role: "button", label: "Try again" });
    const links = await probe.dom('a[href="https://den.example.test/dashboard/ai-gateway?tab=openwork-models&workbotOrganizationId=org_recovery"][target="_blank"][rel~="noopener"]');
    await user.see({ role: "textbox", label: "Message Workbot" }, { value: "Keep this draft" });
    evidence.recordAssertionEvidence("The upgrade opens separately for the exact workspace and keeps the draft", `Exact workspace/new-tab links=${links.elements.length}; draft remains visible`, links.elements.length === 1);
    expect(links.elements.length).toBe(1);
    await user.screenshot();
  });
  await step("a member without billing access gets an admin next step", async () => {
    await user.navigate(`${world.url}?recovery=on&persona=member`);
    await user.see({ text: "Ask a workspace admin to choose another model to keep going." });
    await user.notSee({ role: "link", label: /^Upgrade models/ });
    await user.notSee({ role: "link", label: /^Manage billing/ });
    const actions = await probe.dom('[data-testid="workbot-model-recovery"] a');
    evidence.recordAssertionEvidence("A member cannot open purchase or management actions", `Recovery links=${actions.elements.length}`, actions.elements.length === 0);
    expect(actions.elements.length).toBe(0);
    await user.screenshot();
  });
  await step("a workspace cap offers a model change while a payment problem offers billing", async () => {
    await user.navigate(`${world.url}?recovery=on&issue=usage`);
    await user.see({ text: /Your workspace's model usage limit has been reached/ });
    await user.see({ role: "link", label: /^Change Workbot's model/ });
    await user.notSee({ role: "link", label: /^Upgrade models/ });
    const usage = world.witness("usage");
    await user.navigate(`${world.url}?recovery=on&issue=payment`);
    await user.see({ role: "link", label: /^Manage billing/ });
    await user.notSee({ role: "link", label: /^Upgrade models/ });
    const payment = world.witness("payment");
    evidence.recordAssertionEvidence("Caps and payment failures each stop after one request without a new subscription offer", `Cap attempts=${usage.attempts}; payment attempts=${payment.attempts}`, usage.attempts === 1 && payment.attempts === 1);
    expect([usage.attempts, payment.attempts]).toEqual([1, 1]);
    await user.screenshot();
  });
  await step("a temporary rate limit retries without a purchase prompt", async () => {
    await user.navigate(`${world.url}?recovery=on&issue=temporary`);
    await user.see({ text: "I couldn't reach the AI model just now." });
    await user.see({ role: "button", label: "Try again" });
    await user.notSee({ testId: "workbot-model-recovery" });
    const witness = world.witness("temporary");
    evidence.recordAssertionEvidence("An untrusted error body cannot create an upgrade prompt", `Transient attempts=${witness.attempts}; retryable=${witness.retryable}`, witness.attempts === 3 && witness.retryable === true);
    expect(witness).toEqual({ attempts: 3, retryable: true });
    await user.screenshot();
  });
  await step("after the allowance resets the member explicitly retries the same message", async () => {
    await user.navigate(`${world.url}?recovery=on&cleared=1`);
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await user.see({ role: "button", label: "Try again" });
    await user.click({ role: "button", label: "Try again" });
    await probe.eventually(() => world.recoveredTurn(), { within: 5000, label: "The same message finishes after access returns", until: turn => turn.copies === 1 && turn.status === "done" });
    await probe.eventually(() => probe.dom('[data-testid="workbot-model-recovery"]'), { within: 5000, label: "The completed answer replaces the recovery prompt", until: snapshot => snapshot.elements.length === 0 });
    await user.notSee({ testId: "workbot-model-recovery" });
    await user.see({ text: "Keep our earlier work" });
    await user.see({ text: "Your conversation is still here." });
    const layout = await probe.dom("body");
    const { copies } = await world.recoveredTurn();
    evidence.recordAssertionEvidence("The chat recovers at phone size without duplicating the message", `Document width=${layout.documentWidth}; viewport=${layout.viewportWidth}; copies of the retried message=${copies}`, layout.documentWidth <= layout.viewportWidth && copies === 1);
    expect(copies).toBe(1);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    await user.screenshot();
  });
});
