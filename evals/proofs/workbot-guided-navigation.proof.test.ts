import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotWorkspace } from "../worlds/workbot-workspace.ts";

const test = spec.world(workbotWorkspace, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("Workbot offers a document it mentions and the conversation stays open beside it", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  // The member's main chat on Home, past its first-run welcome.
  world.seedOwnerConversation("Hi Workbot");
  await step("before: opening a linked document from the main chat leaves the conversation behind", async () => {
    await user.navigate(world.url);
    await user.type({ role: "textbox", label: "Message Workbot" }, "Where are the budget notes?");
    await user.press("Enter");
    await user.see({ role: "link", label: "Budget notes", nth: 0 });
    await user.notSee({ testId: "workbot-document-offer" });
    await user.click({ role: "link", label: "Budget notes", nth: 0 });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Budget overview" });
    const chat = await probe.dom("[data-workbot-workspace-chat]");
    evidence.recordAssertionEvidence("Without guided navigation the chat collapses after opening", "Budget notes opened; no conversation beside it", chat.elements.length === 0);
    expect(chat.elements).toHaveLength(0);
    await user.screenshot();
  });
  await step("after: from the main chat, Workbot's Open action shows the document with the same conversation open beside it", async () => {
    await user.navigate(`${world.url}?guided=on`);
    await user.see({ role: "button", label: "Open Budget notes", nth: 0 });
    await user.notSee({ role: "button", label: "Open Restricted document" });
    expect(await probe.url()).not.toContain("/documents");
    evidence.recordAssertionEvidence("The main chat offers one document, quietly, under the reply", "One Open action; the second link stays inline", (await probe.dom("[data-workbot-document-offer]")).elements.length >= 1);
    await user.screenshot();
    await user.click({ role: "button", label: "Open Budget notes", nth: 0 });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Budget overview" });
    const chat = await probe.eventually(() => probe.dom("[data-workbot-workspace-chat]"), { within: 3000, label: "the conversation opens beside the document", until: layout => layout.elements.length === 1 });
    await user.see({ testId: "workbot-view-context", text: /Budget notes\.txt · Read-only context/ });
    await user.see({ text: "Where are the budget notes?" });
    expect(await probe.url()).toContain("/documents");
    evidence.recordAssertionEvidence("The same conversation is open beside the opened document", "Earlier question visible in the floating chat; context chip names Budget notes.txt", chat.elements.length === 1);
    await user.screenshot();
  });
  await step("the next question carries the document the member is now looking at", async () => {
    const before = world.messages().length;
    await user.type({ role: "textbox", label: "Message Workbot" }, "What changed here?");
    await user.press("Enter");
    const sent = await probe.eventually(() => world.messages(), { within: 5000, label: "the follow-up carries the opened document", until: values => values.length === before + 1 });
    expect(sent.at(-1)).toMatchObject({ text: "What changed here?", context: { kind: "document", fileId: "file_budget", title: "Budget notes.txt" } });
    await user.see({ text: "What changed here?" });
    await user.notSee({ role: "button", label: "Open Budget notes" });
    evidence.recordAssertionEvidence("The follow-up refers to the document Workbot offered", JSON.stringify(sent.at(-1)), JSON.stringify(sent.at(-1)).includes("file_budget"));
    await user.screenshot();
  });
  await step("a link the member cannot open does not replace the open document", async () => {
    await user.notSee({ role: "button", label: "Open Restricted document" });
    await user.click({ role: "link", label: "Restricted document", nth: 0 });
    await user.see({ text: "Couldn't open this document. Check your Drive connection and access." });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Budget overview" });
    evidence.recordAssertionEvidence("Den still decides access when a linked document is chosen", world.opened().join(","), !world.opened().includes("file_private"));
    await user.screenshot();
  });
  await step("before: a reply that used Workbot's computer offers nothing without guided navigation", async () => {
    await user.navigate(`${world.url}?computer=on`);
    await user.type({ role: "textbox", label: "Message Workbot" }, "Check the budget site on your computer");
    await user.press("Enter");
    await user.see({ text: "I checked the budget site on my computer." });
    await user.notSee({ role: "button", label: "Open Computer" });
    await user.screenshot();
  });
  await step("after: the latest reply that used the computer opens it with the same conversation beside it", async () => {
    await user.navigate(`${world.url}?guided=on&computer=on`);
    await user.see({ role: "button", label: "Open Computer" });
    evidence.recordAssertionEvidence("Only the newest reply that used the computer offers it", "One Open Computer action", (await probe.dom("[data-workbot-computer-offer]")).elements.length === 1);
    await user.screenshot();
    await user.click({ role: "button", label: "Open Computer" });
    const chat = await probe.eventually(() => probe.dom("[data-workbot-workspace-chat]"), { within: 3000, label: "the conversation opens beside the computer", until: layout => layout.elements.length === 1 });
    await user.see({ text: "Check the budget site on your computer" });
    await user.notSee({ role: "button", label: "Open Computer" });
    expect(await probe.url()).toContain("/computer");
    evidence.recordAssertionEvidence("The same conversation is open beside Workbot's computer", "Earlier question visible in the floating chat on /computer", chat.elements.length === 1);
    await user.screenshot();
  });
});
