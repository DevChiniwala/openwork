import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { browserTeaching } from "../worlds/browser-teaching.ts";

const test = spec.world(browserTeaching, { timeout: 240_000, needs: { placement: "local" }, resources: { surfaces: [], services: ["den"] } });

test("a member teaches a browser lookup, saves a private skill and runs it with a different input", async ({ world, user, probe, step, evidence }) => {
  const person = user.on(world.registry);
  await step("before: the member chooses the browser tab to teach", async () => {
    await user.click({ role: "button", label: "Teach Workbot" });
    await user.see({ role: "combobox", label: "Tab to teach" });
    await user.click({ role: "button", label: "Start teaching" });
    await user.see({ text: "You have browser control" });
    evidence.recordAssertionEvidence("Recording starts only for the chosen tab", `phase=${world.state().demonstration?.phase}`, world.state().demonstration?.phase === "recording");
    await user.screenshot();
  });
  await step("the member demonstrates a search and explains the changing input alongside it", async () => {
    await person.type({ role: "textbox", label: "Name" }, "example one", { replace: true });
    await person.click({ role: "button", label: "Search" });
    await person.see({ text: "Pending" });
    await probe.eventually(() => world.state(), { within: 10_000, label: "the semantic field edit is recorded", until: value => Boolean(value.demonstration?.steps.some(step => step.kind === "fill")) });
    await user.type({ role: "textbox", label: "Explain this step" }, "Use a different person name each time. Ask me when several matches remain.", { replace: true });
    await user.click({ role: "button", label: "Send explanation" });
    await user.see({ text: "Explanation added to the conversation" });
    await user.click({ role: "button", label: /fill Name/ });
    await user.type({ role: "textbox", label: "Input name" }, "person_name", { replace: true });
    await user.click({ role: "button", label: "Save step" });
    expect(world.state().demonstration?.steps.filter(step => step.kind === "fill")).toHaveLength(1);
    expect(world.turns().at(-1)?.readOnly).toBe(true);
    expect(world.turns().at(-1)?.prompt).toContain("[OpenWork browser teaching v1]");
    evidence.recordAssertionEvidence("The explanation reaches a read-only conversation with its recorded steps", `recorded steps=${world.state().demonstration?.steps.length}; readOnly=${world.turns().at(-1)?.readOnly}`, world.turns().at(-1)?.readOnly === true);
  });
  await step("the member selects the information to collect without recording its example value", async () => {
    await user.click({ role: "button", label: "Select information" });
    await person.click({ text: "Pending" });
    await user.see({ role: "button", label: /Collect Registration status/ });
    await user.click({ role: "button", label: /Collect Registration status/ });
    await user.type({ role: "textbox", label: "Output field" }, "status", { replace: true });
    await user.click({ role: "button", label: "Save step" });
    const raw = await world.recorded();
    expect(raw).not.toContain("Example One"); expect(raw).not.toContain("example one"); expect(raw).not.toContain("fixture-secret-never-record"); expect(raw).not.toContain('"Pending"');
    evidence.recordAssertionEvidence("Extraction remembers the field label, while entered and protected values stay out", "Recorded Registration status; no example name, extracted value or password in the persisted demonstration.", !raw.includes("Example One") && !raw.includes("fixture-secret-never-record") && !raw.includes('"Pending"'));
    await user.screenshot();
  });
  await step("paused work and page-script clicks do not enter the demonstrated workflow", async () => {
    await user.click({ role: "button", label: "Pause recording" });
    const count = world.state().demonstration?.steps.length;
    expect(world.state().demonstration?.steps.some(step => step.target?.name === "Scripted decoy")).toBe(false);
    await person.type({ role: "textbox", label: "Name" }, "Paused private input", { replace: true });
    await person.click({ role: "button", label: "Search" });
    await user.click({ role: "button", label: "Finish teaching" });
    expect(world.state().demonstration?.steps).toHaveLength(count ?? 0);
    evidence.recordAssertionEvidence("Only demonstrated trusted input is included", `steps before/after paused activity=${count}/${world.state().demonstration?.steps.length}`, count === world.state().demonstration?.steps.length);
  });
  await step("after: the reviewed demonstration is saved through the normal private Cloud skill tool", async () => {
    await user.type({ role: "textbox", label: "Skill name" }, "Registry lookup", { replace: true });
    await user.type({ role: "textbox", label: "When to use this skill" }, "Use when asked to look up a person in the example public registry.", { replace: true });
    await user.click({ role: "button", label: "Save private skill" });
    await user.see({ text: /Saved .*registry-lookup.*private skills/ }, { timeoutMs: 30_000 });
    const source = await world.savedSkill();
    expect(source).toContain("person_name"); expect(source).toContain("Registration status"); expect(source).not.toContain("Example One"); expect(source).not.toContain("Paused private input");
    evidence.recordAssertionEvidence("The saved skill is discoverable through the member's real get_skill tool", "Den returned the saved skill with its parameter, extraction field and teacher explanation.", source.includes("person_name") && source.includes("Ask me when several matches remain"));
    await user.screenshot();
  });
  await step("the saved skill runs through fresh browser targets with a new person name", async () => {
    await user.type({ role: "textbox", label: "Inputs for a new run" }, "person_name=Example Two", { replace: true });
    await user.click({ role: "button", label: "Run skill" });
    await user.see({ text: /Active/ }, { timeoutMs: 30_000 });
    expect(world.turns().at(-1)?.readOnly).toBe(false);
    const result = JSON.stringify(world.runResult());
    expect(result).toContain("Active"); expect(result).not.toContain("Pending");
    evidence.recordAssertionEvidence("A deterministic model re-reads the stored skill and executes the taught targets in the real browser", "The second lookup returned Active using a new input and fresh browser observations; no paid inference or VM was used.", result.includes("Active") && !result.includes("Pending"));
    await user.screenshot();
  });
});
