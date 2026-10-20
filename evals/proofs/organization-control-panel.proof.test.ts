import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { organizationControlPanelWorld } from "../worlds/organization-control-panel.ts";

const test = spec.world(organizationControlPanelWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("a platform admin grants an organization extra Auto usage and can block or revoke it without losing history", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.admin), adminProbe = probe.on(world.admin);
  const member = user.on(world.member), anonymous = user.on(world.anonymous);

  await step("before: temporary usage grants are locked until the organization rollout is enabled", async () => {
    await admin.see({ role: "heading", label: "Organization grants are off" }, { timeoutMs: 60_000 });
    const state = await world.panel();
    evidence.recordAssertionEvidence("The new grant workflow starts disabled and preserves the existing Web access setting", `rollout=${state.enabled}; grants=${state.grants.length}; legacy access=${state.legacyWebAccess}`, !state.enabled && state.grants.length === 0);
    expect(state.enabled).toBe(false);
    await admin.screenshot();
  });

  await step("after: the admin enables the rollout and opens the organization control panel", async () => {
    await admin.click({ role: "link", label: "Enable Organization control panel and grants in Features" });
    await admin.see({ testId: "admin-capability-organizationGrants" });
    await admin.click({ testId: "admin-capability-organizationGrants" });
    await admin.see({ testId: "admin-capability-source-organizationGrants" }, { text: "Set for this organization" });
    await admin.click({ role: "link", label: "Control panel" });
    await admin.see({ testId: "admin-organization-control-panel" });
    const state = await world.panel();
    evidence.recordAssertionEvidence("Organization access and grants share one destination", `rollout=${state.enabled}; standard weekly allowance=${state.freeAuto.weeklyLimitUsd}; grants=${state.grants.length}`, state.enabled && state.grants.length === 0);
    expect(state.enabled).toBe(true);
    await admin.screenshot();
  });

  await step("the admin awards a finite extra allowance that does not expire or refill", async () => {
    await admin.click({ role: "button", label: "Create grant" });
    await admin.click({ role: "button", label: "Grant expiration" });
    await admin.click({ role: "option", label: "No expiration" });
    await admin.type({ role: "textbox", label: "Grant reason" }, "Extended evaluation");
    await admin.see({ role: "button", label: "Grant type" }, { text: "Extra usage" });
    await admin.screenshot();
    await admin.click({ testId: "admin-grant-create-submit" });
    await admin.see({ testId: "admin-control-panel-status" }, { text: "Grant created." });
    const state = await world.panel();
    const grant = state.grants.find(item => item.reason === "Extended evaluation");
    const ok = grant?.amountUsd === 25 && grant.expiresAt === null && state.freeAuto.extraRemainingUsd === 25 && !state.freeAuto.unlimited;
    evidence.recordAssertionEvidence("No expiration preserves a finite one-time balance", `amount=${grant?.amountUsd}; expiry=${grant?.expiresAt}; remaining=${state.freeAuto.extraRemainingUsd}; unlimited=${state.freeAuto.unlimited}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("an explicit disable blocks the grant and retains its full balance", async () => {
    await admin.click({ role: "button", label: "Free Auto organization setting" });
    await admin.click({ role: "option", label: "Disabled" });
    await admin.see({ testId: "admin-benefit-effective-freeAuto" }, { text: /^Disabled/ });
    const state = await world.panel();
    const ok = !state.access.freeAuto.enabled && state.grants[0]?.state === "blocked" && state.freeAuto.extraRemainingUsd === 25;
    evidence.recordAssertionEvidence("A grant cannot override an organization disable", `access=${state.access.freeAuto.enabled}; grant=${state.grants[0]?.state}; remaining=${state.freeAuto.extraRemainingUsd}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("unlimited usage can expire independently while the finite balance remains available", async () => {
    await admin.click({ role: "button", label: "Free Auto organization setting" });
    await admin.click({ role: "option", label: "Use default" });
    await admin.see({ testId: "admin-benefit-effective-freeAuto" }, { text: /^Enabled/ });
    await admin.click({ role: "button", label: "Create grant" });
    await admin.click({ role: "button", label: "Grant type" });
    await admin.click({ role: "option", label: "Unlimited usage" });
    await admin.type({ role: "textbox", label: "Grant reason" }, "Unlimited evaluation");
    await admin.click({ testId: "admin-grant-create-submit" });
    await admin.see({ testId: "admin-grant-remaining" }, { text: "Unlimited" });
    const state = await world.panel();
    const grant = state.grants.find(item => item.kind === "unlimited");
    const ok = state.freeAuto.unlimited && state.freeAuto.extraRemainingUsd === 25 && grant?.amountUsd === null && Boolean(grant.expiresAt);
    evidence.recordAssertionEvidence("Amount and duration remain separate grant choices", `unlimited=${state.freeAuto.unlimited}; finite balance=${state.freeAuto.extraRemainingUsd}; expiry=${grant?.expiresAt}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("revoking unlimited access restores the finite grant and keeps the old award in history", async () => {
    const before = await world.panel();
    const unlimited = before.grants.find(item => item.kind === "unlimited");
    if (!unlimited) throw new Error("The unlimited grant was not created.");
    await admin.click({ testId: `admin-grant-${unlimited.id}` });
    await admin.click({ role: "button", label: "Revoke grant" });
    await admin.see({ testId: "admin-control-panel-status" }, { text: /^Grant revoked\./ });
    await admin.click({ role: "button", label: "Show history" });
    await admin.see({ testId: `admin-grant-${unlimited.id}` }, { text: /revoked/i });
    const state = await world.panel(true);
    const ok = !state.freeAuto.unlimited && state.freeAuto.extraRemainingUsd === 25 && state.grants.find(item => item.id === unlimited.id)?.state === "revoked";
    evidence.recordAssertionEvidence("Revocation returns to the previous entitlement without deleting the grant", `unlimited=${state.freeAuto.unlimited}; remaining=${state.freeAuto.extraRemainingUsd}; history=${state.grants.length}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("the control panel and grant editor fit a narrow phone screen", async () => {
    await admin.resizeViewport({ width: 320, height: 900, deviceScaleFactor: 1 });
    await admin.click({ role: "button", label: "Create grant" });
    await admin.see({ testId: "admin-grant-form" });
    const layout = await adminProbe.dom('[data-testid="admin-organization-control-panel"], [data-testid="admin-grant-form"] input, [data-testid="admin-grant-form"] button');
    const ok = layout.documentWidth <= layout.viewportWidth && layout.elements.length > 0 && layout.elements.every(item => item.rect.left >= 0 && item.rect.left + item.rect.width <= layout.viewportWidth);
    evidence.recordAssertionEvidence("The panel, date fields and grant actions stay inside 320 pixels", `document=${layout.documentWidth}; viewport=${layout.viewportWidth}; elements=${layout.elements.length}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("organization members and signed-out visitors cannot read or award platform grants", async () => {
    await member.see({ role: "heading", label: "Admin access required" }, { timeoutMs: 60_000 });
    await anonymous.see({ role: "heading", label: "Sign in required" });
    const access = await world.memberAccess();
    const ok = access.read === 403 && access.write === 403;
    evidence.recordAssertionEvidence("Organization ownership does not grant platform administration", `member read=${access.read}; member write=${access.write}`, ok);
    expect(ok).toBe(true);
    await member.screenshot();
  });
});
