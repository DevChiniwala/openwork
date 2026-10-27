import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { automationScheduleTriggersWorld } from "../worlds/automation-schedule-triggers.ts";

const test = spec.world(automationScheduleTriggersWorld, { timeout: 600_000, resources: { surfaces: ["appWeb"], services: ["den"] } });
const WITHIN = 60_000;

test("a member schedules an Automation every few hours, or around their meetings, once their organization has each", async ({ world, user, probe, step, evidence }) => {
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

  await step("after: with meeting triggers on, the member picks Around my meetings, 5 minutes after each ends", async () => {
    await world.turnOnCalendarTriggers();
    await user.reload();
    await openNewAutomation();
    const choices = await probe.eventually(scheduleChoices, { within: WITHIN, label: "the Schedule menu offers Around my meetings", until: (values) => values.includes("Around my meetings") });
    await user.click({ text: "Schedule" });
    await user.press("a");
    await user.see({ label: "Runs" }, { timeoutMs: WITHIN });
    await user.see({ label: "Only meetings with people outside my organization" });
    const moment = (await probe.dom("#automation-meeting-moment option:checked")).elements.map((element) => element.text.trim());
    evidence.recordAssertionEvidence("5 minutes after each meeting ends is the starting choice", `${choices.join(", ")} → ${moment.join(", ")}`, moment.join(",") === "5 min after it ends");
    expect(moment).toEqual(["5 min after it ends"]);
    await user.screenshot();
  });
});
