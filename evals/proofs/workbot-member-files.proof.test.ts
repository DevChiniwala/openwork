import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotMemberFiles } from "../worlds/workbot-member-files.ts";

const test = spec.world(workbotMemberFiles, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

const panel = "[data-workbot-member-files]";
const present = (layout: { elements: unknown[] }) => layout.elements.length > 0;

test("a member sees every file their chats, computer and browser saved in one My files, opens them from answers, and manages them", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 820, deviceScaleFactor: 1 });

  await step("before: with My files off the header says Files and lists only this chat's files", async () => {
    await user.see({ text: /added it up/ });
    await user.click({ role: "button", label: "Files" });
    await user.see({ text: "expense-policy.pdf" });
    const absent = (await probe.dom(panel)).elements.length === 0;
    evidence.recordAssertionEvidence("Without the feature nothing changes: the chat's own Files panel", "Files panel lists expense-policy.pdf; no My files panel", absent);
    expect(absent).toBe(true);
    await user.screenshot();
    await user.press("Escape");
  });

  await user.navigate(world.url);

  await step("after: the answer links the files it made, and shows them as cards to open", async () => {
    await user.see({ role: "button", label: "My files" });
    await user.see({ role: "button", label: /october-statement\.csv/ });
    const links = (await probe.dom('button[title^="Open /files/"]')).elements.map((element) => element.text);
    evidence.recordAssertionEvidence("Both /files links in the answer are live", links.join(" | "), links.includes("october-statement.csv") && links.includes("october-total.txt"));
    expect(links).toEqual(expect.arrayContaining(["october-statement.csv", "october-total.txt"]));
    await user.screenshot();
  });

  await step("a link in the answer opens the downloaded statement beside the chat", async () => {
    await user.click({ role: "button", label: "october-statement.csv" });
    await user.see({ text: /Coffee beans/ });
    const preview = (await probe.dom("table")).elements.map((element) => element.text.replace(/\s+/g, " ")).join(" ");
    const rows = preview.includes("Coffee beans") && preview.includes("23.50");
    evidence.recordAssertionEvidence("The browser's download opens in the preview from its /files link", preview.slice(0, 160), rows);
    expect(rows).toBe(true);
    await user.screenshot();
  });

  await step("My files lists every folder with where each file came from and how much is used", async () => {
    await user.click({ role: "button", label: "My files" });
    await probe.eventually(() => probe.dom(`${panel} [data-member-file]`), { within: 5000, label: "My files are listed", until: present });
    const rows = (await probe.dom(`${panel} [data-member-file]`)).elements.map((element) => element.text.replace(/\s+/g, " ").trim());
    const origins = ["From bank.example.test", "From rail.example.test", "Made on the computer", "Made by Workbot", "Added by you"];
    const shown = origins.every((origin) => rows.some((row) => row.includes(origin)));
    evidence.recordAssertionEvidence("Each file says where it came from", rows.join(" | "), shown);
    expect(shown).toBe(true);
    await user.see({ text: /6 files · 1\.6 MB of 10\.0 GB/ });
    await user.see({ text: "Sent in this chat" });
    await user.screenshot();
  });

  await step("deleting asks first, then removes the file from My files", async () => {
    await user.hover({ text: "train-receipt.pdf" });
    await user.click({ role: "button", label: "Delete train-receipt.pdf" });
    await user.see({ role: "button", label: "Delete train-receipt.pdf from My files" });
    await user.screenshot();
    await user.click({ role: "button", label: "Delete train-receipt.pdf from My files" });
    await probe.eventually(() => probe.dom('[data-member-file="Downloads/train-receipt.pdf"]'), { within: 5000, label: "the row is gone", until: (layout) => layout.elements.length === 0 });
    evidence.recordAssertionEvidence("The delete reached Workbot for that file only", JSON.stringify(world.deleted()), world.deleted().join() === "Downloads/train-receipt.pdf");
    expect(world.deleted()).toEqual(["Downloads/train-receipt.pdf"]);
  });

  await step("adding a file puts it in Uploads, where every chat and the computer can use it", async () => {
    await user.attachFiles("[data-member-files-input]", [world.briefPath]);
    await probe.eventually(() => probe.dom('[data-member-file="Uploads/project-brief.txt"]'), { within: 5000, label: "the added file is listed", until: present });
    const row = (await probe.dom('[data-member-file="Uploads/project-brief.txt"]')).elements[0]?.text ?? "";
    evidence.recordAssertionEvidence("The file lands in Uploads, marked as added by the member", row.replace(/\s+/g, " "), row.includes("Added by you") && world.added().join() === "Uploads/project-brief.txt");
    expect(world.added()).toEqual(["Uploads/project-brief.txt"]);
    await user.screenshot();
  });

  await step("a member with no files yet sees where they will come from and can add one", async () => {
    await user.navigate(`${world.url}?empty=1`);
    await user.click({ role: "button", label: "My files" });
    await user.see({ text: /Browser downloads, files Workbot makes and files you add show up here/ });
    await user.see({ role: "button", label: "Add files" });
    const listed = (await probe.dom(`${panel} [data-member-file]`)).elements.length;
    evidence.recordAssertionEvidence("The empty panel invites instead of explaining the interface", `${listed} files listed; the three sources named; Add files offered`, listed === 0);
    expect(listed).toBe(0);
    await user.screenshot();
    await user.press("Escape");
    await user.navigate(world.url);
    await user.click({ role: "button", label: "My files" });
    await probe.eventually(() => probe.dom(`${panel} [data-member-file]`), { within: 5000, label: "My files are listed again", until: present });
  });

  await step("on a phone the panel fills the screen without scrolling sideways", async () => {
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    // The panel slides in (200ms): measured once it has settled.
    const layout = await probe.eventually(() => probe.dom(panel), { within: 3000, label: "the panel settles at the phone's width", until: (found) => (found.elements[0]?.rect.right ?? Infinity) <= found.viewportWidth });
    const fits = (layout.elements[0]?.rect.right ?? Infinity) <= layout.viewportWidth && layout.documentWidth <= layout.viewportWidth;
    evidence.recordAssertionEvidence("My files fits a 390px screen", `right ${layout.elements[0]?.rect.right} of ${layout.viewportWidth}`, fits);
    expect(fits).toBe(true);
    await user.screenshot();
  });
});
