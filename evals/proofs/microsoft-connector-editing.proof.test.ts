import { expect } from "vitest";
import { spec, type Target } from "@openwork/testkit";
import {
  microsoftConnectorEditing, microsoftConnectorEditingOff,
  INITIAL_CLIENT_ID, INITIAL_TENANT_ID, CHANGED_CLIENT_ID, CHANGED_TENANT_ID, ROTATED_SECRET,
  EXTERNAL_CLIENT_ID, EXTERNAL_TENANT_ID,
} from "../worlds/microsoft-connector-editing.ts";

const test = spec.world(microsoftConnectorEditing, {
  timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] },
});
const off = spec.world(microsoftConnectorEditingOff, {
  timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] },
});
const client = { testId: "native-provider-client-id" };
const tenant = { testId: "native-provider-tenant-id" };
const secret = { testId: "native-provider-client-secret" };
const save: Target = { role: "button", label: "Save changes" };
const secretSelector = '[data-testid="native-provider-client-secret"]';

// The browser drives the real settings disclosure. Network observation retains only field names/status.
test("an admin edits a saved Microsoft 365 app without replacing unchanged credentials", async ({ world, user, probe, step, evidence }) => {
  const disabled = async () => (await probe.dom('button:disabled')).elements.some((element) => element.text === "Save changes");
  const saved = async (count: number) => {
    const writes = await probe.eventually(world.writes, {
      within: 30_000, until: (writes) => writes.length === count && writes[count - 1]?.status === 200,
      label: "Microsoft settings saved successfully",
    });
    expect(writes).toHaveLength(count);
    expect(writes[count - 1]?.status).toBe(200);
    await user.see(secret, { value: "" });
    return writes[count - 1];
  };

  await step("after: opening Settings immediately shows the saved tenant and app IDs with a blank secret", async () => {
    await user.click({ testId: "connector-settings-toggle" });
    await user.see(client, { editable: true, value: INITIAL_CLIENT_ID, timeoutMs: 60_000 });
    await user.see(tenant, { editable: true, value: INITIAL_TENANT_ID });
    await user.see(secret, { value: "" });
    await user.see({ text: "Leave blank to keep the saved secret." });
    await user.notSee({ role: "button", label: "Replace credentials" });
    const state = await probe.credentialInputState(secretSelector);
    const config = await world.config();
    const ok = await disabled() && state.empty && state.inputType === "password" && !config.secretReturned && world.writes().length === 0;
    evidence.recordAssertionEvidence("Saved IDs are editable immediately, the secret stays private, and unchanged settings cannot save", `blank password=${state.empty && state.inputType === "password"}; Save disabled=${await disabled()}; secret in GET=${config.secretReturned}; writes=${world.writes().length}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("the same saved app is readable on a narrow screen without revealing its secret", async () => {
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await user.see(client, { value: INITIAL_CLIENT_ID });
    await user.see(secret, { value: "" });
    const layout = await probe.dom('[data-testid="native-provider-microsoft-365"]');
    const ok = layout.documentWidth <= layout.viewportWidth;
    evidence.recordAssertionEvidence("Settings fit the narrow viewport", `document=${layout.documentWidth}px; viewport=${layout.viewportWidth}px; writes=${world.writes().length}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
    await user.resizeViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
  });

  await step("an empty app ID or a different app without its new secret cannot be saved", async () => {
    await user.type(client, "", { replace: true });
    expect(await disabled()).toBe(true);
    await user.type(client, CHANGED_CLIENT_ID, { replace: true });
    expect(await disabled()).toBe(true);
    const ok = world.writes().length === 0;
    evidence.recordAssertionEvidence("Incomplete app credentials never reach the server", `Save disabled=${await disabled()}; writes=${world.writes().length}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
    await user.type(client, INITIAL_CLIENT_ID, { replace: true });
  });

  await step("after: permission-only changes save without sending any credential fields", async () => {
    await user.click({ role: "checkbox", label: "Read Outlook mail" });
    await user.click(save);
    const write = await saved(1);
    const config = await world.config();
    const ok = write.fields.join() === "features" && Array.isArray(config.features) && config.features.includes("mailRead") && config.clientId === INITIAL_CLIENT_ID && config.tenantId === INITIAL_TENANT_ID;
    evidence.recordAssertionEvidence("Permission changes omit all credentials and preserve the saved app identity", `HTTP=${write.status}; sent fields=${write.fields.join(", ")}; mail read saved=${Array.isArray(config.features) && config.features.includes("mailRead")}; identity unchanged=${config.clientId === INITIAL_CLIENT_ID && config.tenantId === INITIAL_TENANT_ID}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("after: rotating only the secret saves directly without a sign-out confirmation", async () => {
    await user.type(secret, ROTATED_SECRET, { replace: true });
    await user.click(save);
    const write = await saved(2);
    await user.notSee({ role: "heading", label: "Change Microsoft 365 app?" });
    const config = await world.config();
    const ok = write.fields.includes("clientSecret") && !write.fields.includes("clientId") && !write.fields.includes("tenantId") && config.clientId === INITIAL_CLIENT_ID && config.tenantId === INITIAL_TENANT_ID;
    evidence.recordAssertionEvidence("Secret rotation succeeds without replacing the app identity", `HTTP=${write.status}; sent fields=${write.fields.join(", ")}; identity unchanged=${config.clientId === INITIAL_CLIENT_ID && config.tenantId === INITIAL_TENANT_ID}; secret in GET=${config.secretReturned}`, ok && !config.secretReturned);
    expect(ok && !config.secretReturned).toBe(true);
    await user.screenshot();
  });

  await step("changing the app warns about sign-outs, while Cancel keeps the draft and saved app untouched", async () => {
    await user.type(client, CHANGED_CLIENT_ID, { replace: true });
    await user.type(tenant, CHANGED_TENANT_ID, { replace: true });
    await user.type(secret, "synthetic-m365-new-app-only", { replace: true });
    await user.see({ text: "Changing the tenant or client ID signs everyone out. The new app may need different permissions." });
    await user.click(save);
    await user.see({ role: "heading", label: "Change Microsoft 365 app?" });
    await user.see({ role: "button", label: "Save and sign everyone out" });
    await user.screenshot();
    await user.click({ role: "button", label: "Cancel" });
    await user.see(client, { value: CHANGED_CLIENT_ID });
    await user.see(tenant, { value: CHANGED_TENANT_ID });
    const config = await world.config();
    const ok = world.writes().length === 2 && config.clientId === INITIAL_CLIENT_ID && config.tenantId === INITIAL_TENANT_ID;
    evidence.recordAssertionEvidence("Cancel preserves the draft but performs no save", `writes=${world.writes().length}; original app saved=${config.clientId === INITIAL_CLIENT_ID}; original tenant saved=${config.tenantId === INITIAL_TENANT_ID}`, ok);
    expect(ok).toBe(true);
  });

  await step("after: explicitly confirming the sign-out warning saves the new app and tenant", async () => {
    const readsBefore = world.configReads();
    await user.click(save);
    await user.see({ role: "heading", label: "Change Microsoft 365 app?" });
    await user.click({ role: "button", label: "Save and sign everyone out" });
    const write = await saved(3);
    await probe.eventually(world.configReads, { within: 30_000, until: (reads) => reads > readsBefore, label: "own save refetches its current app" });
    await user.notSee({ text: "App credentials changed while you were editing. Reload before saving." });
    const config = await world.config();
    const ok = config.clientId === CHANGED_CLIENT_ID && config.tenantId === CHANGED_TENANT_ID && ["clientId", "tenantId", "clientSecret"].every((field) => write.fields.includes(field)) && !config.secretReturned;
    evidence.recordAssertionEvidence("Only explicit confirmation persists the changed identity", `HTTP=${write.status}; new app saved=${config.clientId === CHANGED_CLIENT_ID}; new tenant saved=${config.tenantId === CHANGED_TENANT_ID}; secret in GET=${config.secretReturned}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("after: a changed app in the owner's other session locks the stale editor when permissions refresh", async () => {
    const otherSessionStatus = await world.changeAppFromOtherOwnerSession();
    const external = await world.config();
    expect(external.clientId).toBe(EXTERNAL_CLIENT_ID);
    expect(external.tenantId).toBe(EXTERNAL_TENANT_ID);
    // The original tab still shows its saved app B, not the other session's app C.
    await user.see(client, { value: CHANGED_CLIENT_ID });
    await user.see(tenant, { value: CHANGED_TENANT_ID });
    await user.see(secret, { value: "" });
    const readsBefore = world.configReads();
    await user.click({ role: "checkbox", label: "Read Outlook mail" });
    await user.click(save);
    const write = await saved(4);
    await user.see({ text: "App credentials changed while you were editing. Reload before saving." }, { timeoutMs: 30_000 });
    const locked = (await probe.dom('[data-testid="native-provider-client-id"]:disabled, [data-testid="native-provider-tenant-id"]:disabled, [data-testid="native-provider-client-secret"]:disabled')).elements.length;
    const config = await world.config();
    const ok = otherSessionStatus === 200 && write.fields.join() === "features" && world.configReads() > readsBefore
      && locked === 3 && await disabled() && world.writes().length === 4
      && config.clientId === EXTERNAL_CLIENT_ID && config.tenantId === EXTERNAL_TENANT_ID && !config.secretReturned;
    evidence.recordAssertionEvidence("A natural refetch locks all stale credentials without overwriting the other session's app", `other owner session HTTP=${otherSessionStatus}; original tab sent=${write.fields.join(", ")}; refetched=${world.configReads() > readsBefore}; disabled credential fields=${locked}; Save disabled=${await disabled()}; browser writes=${world.writes().length}; app C remains saved=${config.clientId === EXTERNAL_CLIENT_ID && config.tenantId === EXTERNAL_TENANT_ID}; secret in GET=${config.secretReturned}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });
});

off("an admin outside the rollout keeps the existing Microsoft 365 credential replacement flow", async ({ world, user, probe, step, evidence }) => {
  await step("before: Settings shows saved credentials and the existing Replace credentials action", async () => {
    await user.click({ testId: "connector-settings-toggle" });
    await user.see({ role: "button", label: "Replace credentials" }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Save permissions" });
    await user.notSee(client);
    const config = await world.config();
    const ok = config.clientId === INITIAL_CLIENT_ID && config.tenantId === INITIAL_TENANT_ID && !config.secretReturned;
    evidence.recordAssertionEvidence("The rollout-off summary retains saved nonsecret metadata", `original app=${config.clientId === INITIAL_CLIENT_ID}; original tenant=${config.tenantId === INITIAL_TENANT_ID}; secret in GET=${config.secretReturned}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });
  await step("the old Replace credentials action still opens its explicit replacement form", async () => {
    await user.click({ role: "button", label: "Replace credentials" });
    await user.see(client, { value: INITIAL_CLIENT_ID });
    await user.see(secret, { value: "" });
    await user.see({ role: "button", label: "Save new credentials" });
    const ok = (await probe.dom('button:disabled')).elements.some((element) => element.text === "Save new credentials") && world.writes().length === 0;
    evidence.recordAssertionEvidence("The old flow requires a replacement secret before saving", `replacement disabled=${ok}; writes=${world.writes().length}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });
  await step("keeping saved credentials returns to the unchanged summary without a write", async () => {
    await user.click({ role: "button", label: "Keep saved credentials" });
    await user.notSee(client);
    await user.see({ role: "button", label: "Save permissions" });
    const ok = world.writes().length === 0;
    evidence.recordAssertionEvidence("Leaving the replacement form does not save anything", `writes=${world.writes().length}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });
});
