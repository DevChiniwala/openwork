import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { nativeDictation } from "../worlds/native-dictation.ts";

const test = spec.world(nativeDictation, { timeout: 90_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a member uses native dictation guidance and reviews an editable message before sending", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("before: the microphone is absent while native dictation is off", async () => {
    await user.see({ role: "textbox", label: "Message Workbot" });
    await user.notSee({ role: "button", label: "Dictate message" });
    evidence.recordAssertionEvidence("The feature starts off", "Workbot is usable without a microphone entry point", (await probe.dom("[data-native-dictation]")).elements.length === 0);
    await user.screenshot();
  });
  await step("after: the microphone focuses the draft and offers Windows voice typing", async () => {
    await user.navigate(`${world.url}?dictation=on&chat=sidechat000000001`);
    await user.type({ role: "textbox", label: "Message Workbot" }, "Plan my week");
    await user.click({ role: "button", label: "Dictate message" });
    await user.see({ text: "Use Windows voice typing" });
    await user.see({ text: /Press Windows \+ H/ });
    const input = (await probe.dom('textarea[aria-label="Message Workbot"]')).elements[0];
    expect(input?.focused).toBe(true);
    evidence.recordAssertionEvidence("Native instructions preserve the message and its focus", "Windows + H is offered; the draft stays editable; no message was sent", input?.focused === true && world.attempts().length === 0);
    await user.screenshot();
  });
  await step("finishing speech with Enter cannot accidentally send the draft", async () => {
    await user.press("Escape");
    await user.see({ role: "textbox", label: "Message Workbot" }, { value: "Plan my week" });
    await user.press("Enter");
    await user.see({ role: "textbox", label: "Message Workbot" }, { value: "Plan my week\n" });
    expect(world.attempts()).toHaveLength(0);
    evidence.recordAssertionEvidence("Enter adds a line during dictation review", "Plan my week remains unsent and editable", world.attempts().length === 0);
  });
  await step("the review controls fit beside the message on a narrow screen", async () => {
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await user.type({ role: "textbox", label: "Message Workbot" }, "Prepare a concise weekly plan", { replace: true });
    await user.see({ role: "button", label: "Return to typing" });
    const layout = await probe.dom("[data-workbot-composer]");
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(world.attempts()).toHaveLength(0);
    evidence.recordAssertionEvidence("Review is available at a phone-sized width", "The draft and Send remain visible without horizontal scrolling", layout.documentWidth <= layout.viewportWidth);
    await user.screenshot();
  });
  await step("the member sends explicitly and can return to ordinary typing", async () => {
    await user.click({ role: "button", label: "Send" });
    const sent = await probe.eventually(() => world.attempts(), { within: 5000, label: "the reviewed message reaches Workbot", until: attempts => attempts.length === 1 });
    expect(sent[0]).toMatchObject({ text: "Prepare a concise weekly plan" });
    await probe.eventually(() => probe.dom("[data-dictation-review]"), { within: 3000, label: "sending ends dictation review", until: layout => layout.elements.length === 0 });
    await user.notSee({ role: "button", label: "Return to typing" });
    await user.click({ role: "button", label: "Dictate message" });
    await user.click({ role: "button", label: "Back to message" });
    await user.click({ role: "button", label: "Return to typing" });
    await user.type({ role: "textbox", label: "Message Workbot" }, "Start with Monday");
    await user.press("Enter");
    await probe.eventually(() => world.attempts(), { within: 5000, label: "ordinary Enter-to-send is restored", until: attempts => attempts.length === 2 });
    evidence.recordAssertionEvidence("Only explicit Send or restored keyboard submission sends messages", "The two chosen messages reached Workbot; no speech was auto-submitted", world.attempts().length === 2);
    await user.screenshot();
  });
});
