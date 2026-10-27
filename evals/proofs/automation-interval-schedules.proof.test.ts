import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { automationIntervalSchedulesWorld } from "../worlds/automation-interval-schedules.ts";

const test = spec.world(automationIntervalSchedulesWorld, { timeout: 600_000, resources: { surfaces: ["appWeb"], services: ["den"] } });
const WITHIN = 60_000;

test("a member schedules an Automation every few hours once their organization has it", async ({ world, user, probe, step, evidence }) => {
  const scheduleChoices = async () => (await probe.dom("#automation-frequency option")).elements.map((element) => element.text.trim());
  async function openNewAutomation() {
    await user.see({ text: "What do you need done?" }, { timeoutMs: WITHIN });
    await user.click({ role: "button", label: "Automations" });
    await user.click({ role: "button", label: "New Automation" });
    await user.see({ label: "Schedule" }, { timeoutMs: WITHIN });
  }
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

  await step("before: the Schedule menu offers Once, Daily and Weekly only", async () => {
    await openNewAutomation();
    const choices = await scheduleChoices();
    evidence.recordAssertionEvidence("Every few hours is not offered yet", choices.join(", "), !choices.includes("Every few hours"));
    expect(choices).toEqual(["Once", "Daily", "Weekly"]);
    await user.screenshot();
  });

  await step("after: with the feature on, the member picks Every few hours and sets 3 hours, 09:00 to 18:00", async () => {
    await world.turnOnIntervalSchedules();
    await user.reload();
    await openNewAutomation();
    const choices = await probe.eventually(scheduleChoices, { within: WITHIN, label: "the Schedule menu offers Every few hours", until: (values) => values.includes("Every few hours") });
    // Clicking the label focuses the menu without opening it; typing picks the option, as on a keyboard.
    await user.click({ text: "Schedule" });
    await user.press("e");
    await user.see({ label: "Every" }, { timeoutMs: WITHIN });
    await user.see({ label: "From" });
    await user.see({ label: "Until" });
    const fields = await probe.dom("#automation-every-hours option:checked, #automation-window-start option:checked, #automation-window-end option:checked");
    const values = fields.elements.map((element) => element.text.trim());
    evidence.recordAssertionEvidence("Every 3 hours from 09:00 until 18:00 is the starting choice", `${choices.join(", ")} → ${values.join(", ")}`, values.join(",") === "3 hours,09:00,18:00");
    expect(values).toEqual(["3 hours", "09:00", "18:00"]);
    await user.screenshot();
  });
});
