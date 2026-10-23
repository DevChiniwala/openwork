import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { DESIGN_PROMPT, EVERYONE_PROMPT, REVISED_DESIGN_PROMPT, orgPromptsDesktop } from "../worlds/org-prompts.ts";

const test = spec.world(orgPromptsDesktop, {
  timeout: 900_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

test("a member's agent follows the organization's prompts for everyone and their team, and stops when Prompts is turned off", async ({ world, user, probe, step, evidence }) => {
  /** Earlier turns keep the instructions they ran with, so each later check starts a new conversation. */
  async function newTask() {
    await user.click({ role: "button", label: "New session" });
    await user.see("composer", { editable: true });
  }

  async function chat(marker: string) {
    const reply = `Done: ${marker}`;
    await world.prepareTurn(marker, reply);
    await user.type("composer", marker, { verify: true });
    await user.click({ role: "button", label: "Run task" });
    await user.see({ text: reply }, { timeoutMs: 120_000 });
  }

  await step("given Riley's OpenWork has synced with Den after sign-in", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    const status = await probe.eventually(() => world.sync(), {
      within: 120_000, label: "Riley's OpenWork has Riley's Den session", until: (value) => value === "applied" || value === "noop",
    });
    expect(["applied", "noop"]).toContain(status);
  });

  await step("when Riley asks the agent for something, the model receives OpenWork's instructions with everyone's prompt and Design's", async () => {
    const seen: Record<string, boolean> = {};
    for (const [label, text] of [["heading", "## Organization instructions"], ["everyone", EVERYONE_PROMPT], ["design", DESIGN_PROMPT]] as const) {
      await world.watchFor(text);
      const marker = `Draft the launch poster (${label}). PROMPTS-${Date.now()}`;
      await chat(marker);
      seen[label] = await world.modelSawWatched(marker);
    }
    const all = Object.values(seen).every(Boolean);
    evidence.recordAssertionEvidence(`the model requests carried the organization's prompts (${world.engine})`, JSON.stringify(seen), all);
    expect(seen).toEqual({ heading: true, everyone: true, design: true });
    await user.screenshot();
  });

  await step("after an admin revises Design's prompt, the next sync brings the new text to the agent", async () => {
    await world.reviseDesignPrompt();
    expect(await world.sync()).toBe("applied");
    await world.watchFor(REVISED_DESIGN_PROMPT);
    await newTask();
    const marker = `Export the poster. PROMPTS-${Date.now()}`;
    await chat(marker);
    const seen = await world.modelSawWatched(marker);
    evidence.recordAssertionEvidence("the model request carried the revised prompt", `seen=${seen}`, seen);
    expect(seen).toBe(true);
  });

  await step("after Prompts is turned off for the organization, the next sync removes them from the agent's instructions", async () => {
    await world.turnPromptsOff();
    expect(await world.sync()).toBe("applied");
    await world.watchFor("## Organization instructions");
    await newTask();
    const marker = `Share the poster. PROMPTS-${Date.now()}`;
    await chat(marker);
    const seen = await world.modelSawWatched(marker);
    evidence.recordAssertionEvidence("the model request no longer carried organization prompts", `seen=${seen}`, !seen);
    expect(seen).toBe(false);
    await user.screenshot();
  });
});
