import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { v2LocalProviderMirror } from "../worlds/v2-local-provider-mirror.ts";

const test = spec.world(v2LocalProviderMirror, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["den"] },
});

const WITHIN = 60_000;

test("an owner's OpenRouter key reaches the new engine's model picker, and AI Providers stays honest about sign-ins and Acme's provider rule", async ({ world, user, probe, step, evidence }) => {
  const openRouterModels = async () => (await probe.dom('[data-testid="composer-model-picker"] [data-model-key^="openrouter:"]')).elements.length;
  const row = async (providerId: string) => (await probe.dom(`[data-testid="local-provider-${providerId}"]`)).elements.map(element => element.text).join(" ");

  /** Open the chat's model picker and search it; opening it also asks the desktop to refresh providers. */
  async function searchPicker(query: string) {
    await user.navigate(world.sessionUrl);
    await user.see("composer", { editable: true, timeoutMs: WITHIN });
    await user.click("Change model");
    await user.see({ testId: "composer-model-picker" });
    await user.type({ label: "Search all models" }, query);
  }

  /** Reopen the picker until it agrees with `until`, as a person would after a change. */
  async function pickerUntil(label: string, until: (count: number) => boolean) {
    return probe.eventually(async () => {
      await searchPicker("OpenRouter");
      const count = await openRouterModels();
      if (!until(count)) await user.press("Escape");
      return count;
    }, { within: 120_000, label, until });
  }

  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  async function connectOpenRouter() {
    await user.navigate(world.settingsUrl);
    await user.see({ role: "button", label: "Connect a provider" }, { timeoutMs: WITHIN });
    await user.click({ role: "button", label: "Connect a provider" });
    await user.type({ label: "Search providers" }, "OpenRouter");
    await user.click({ role: "button", label: /^OpenRouter/ });
    await user.type({ label: "API key" }, world.openRouterKey);
    await user.click({ role: "button", label: "Save key" });
    await user.notSee({ role: "button", label: "Save key" }, { timeoutMs: WITHIN });
  }
  const engineStatus = async () => {
    const status = await probe.desktopApi("/experimental/engine-v2-preview/status");
    const body = typeof status.body === "object" && status.body !== null ? status.body : {};
    return {
      mirrored: "mirroredProviderIds" in body ? JSON.stringify(body.mirroredProviderIds) : "[]",
      skipped: "skippedProviderIds" in body ? JSON.stringify(body.skippedProviderIds) : "[]",
      reasons: "skippedProviders" in body ? JSON.stringify(body.skippedProviders) : "none",
    };
  };

  await step("before: with the rollout off, a saved OpenRouter key never reaches the new engine's model picker", async () => {
    await connectOpenRouter();
    const status = await engineStatus();
    expect(status.skipped).toContain('"openrouter"');
    await searchPicker("OpenRouter");
    await user.see({ text: "OpenRouter isn't connected in this workspace." }, { timeoutMs: WITHIN });
    const count = await openRouterModels();
    expect(count).toBe(0);
    evidence.recordAssertionEvidence("The key is saved, the engine drops it, and the picker says OpenRouter isn't connected", `${count} OpenRouter models listed; engine skipped ${status.skipped}, mirrored ${status.mirrored}`, count === 0 && status.skipped.includes('"openrouter"'));
    await user.screenshot();
    await user.press("Escape");
  });

  await step("after: with the rollout on, connecting OpenRouter reads Ready to use in AI Providers", async () => {
    await world.setMirror(true);
    await connectOpenRouter();
    const text = await probe.eventually(() => row("openrouter"), { within: WITHIN, label: "the OpenRouter row", until: value => value.includes("Ready to use") });
    const status = await engineStatus();
    expect(status.mirrored).toContain('"openrouter"');
    evidence.recordAssertionEvidence("AI Providers and the engine agree the key is ready", `${text}; engine mirrored ${status.mirrored}`, text.includes("Ready to use") && status.mirrored.includes('"openrouter"'));
    await user.screenshot();
  });

  await step("after: OpenRouter's models are in the new engine's model picker", async () => {
    const count = await pickerUntil("OpenRouter models in the picker", value => value > 0);
    expect(count).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("The same key now lists OpenRouter's models on the new engine", `${count} OpenRouter models match "OpenRouter"`, count > 0);
    await user.screenshot();
    await user.press("Escape");
  });

  await step("after: a ChatGPT sign-in the new engine cannot use yet says so instead of Ready to use", async () => {
    await world.signInWithChatGpt();
    await user.navigate(world.settingsUrl);
    await user.see({ testId: "local-provider-openai" }, { timeoutMs: WITHIN });
    const text = await probe.eventually(() => row("openai"), { within: WITHIN, label: "the OpenAI row's state", until: value => value.includes("Not available on the new engine yet") });
    expect(text).not.toContain("Ready to use");
    const openRouter = await probe.eventually(() => row("openrouter"), { within: WITHIN, label: "the OpenRouter row's state", until: value => value.includes("Ready to use") });
    const { reasons } = await engineStatus();
    expect(reasons).toContain('{"id":"openai","reason":"oauth"}');
    evidence.recordAssertionEvidence("The sign-in is neutral and not ready; the OpenRouter key stays ready", `OpenAI: ${text} | OpenRouter: ${openRouter} | engine skipped: ${reasons}`, !text.includes("Ready to use") && openRouter.includes("Ready to use"));
    await user.screenshot();
  });

  await step("after: when Acme allows only its own providers, OpenRouter leaves the picker", async () => {
    await world.allowPersonalProviders(false);
    await user.reload();
    const count = await pickerUntil("OpenRouter gone from the picker", value => value === 0);
    expect(count).toBe(0);
    evidence.recordAssertionEvidence("The personal key no longer reaches the new engine", `${count} OpenRouter models listed`, count === 0);
    await user.screenshot();
    await user.press("Escape");
  });

  await step("after: AI Providers keeps the OpenRouter row with a lock that names who manages providers", async () => {
    await user.navigate(world.settingsUrl);
    const text = await probe.eventually(() => row("openrouter"), {
      within: WITHIN, label: "the locked OpenRouter row", until: value => value.includes(`${world.organizationName} manages AI providers`),
    });
    await user.see({ text: "Provider connections are managed by your organization administrator." });
    const locked = (await probe.dom('[data-testid="local-provider-openrouter"] svg.lucide-lock')).elements.length === 1;
    const connectLocked = (await probe.dom('button[disabled]:has(svg.lucide-lock)')).elements.some(element => element.text.includes("Connect a provider"));
    const { reasons } = await engineStatus();
    expect(text).not.toContain("Ready to use");
    expect(locked).toBe(true);
    expect(connectLocked).toBe(true);
    expect(reasons).toContain('{"id":"openrouter","reason":"policy"}');
    evidence.recordAssertionEvidence("Blocked, not missing: the row stays with a lock and the owner's name, and Connect a provider is locked", `${text}; lock=${locked}; Connect a provider locked=${connectLocked}; engine skipped ${reasons}`, locked && connectLocked);
    await user.screenshot();
  });
});
