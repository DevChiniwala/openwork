import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { v1HistoryCopiedToV2 } from "../worlds/v1-history-copied-to-v2.ts";

const test = spec.world(v1HistoryCopiedToV2, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

const WITHIN = 120_000;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

test("a person who chatted before the update finds that chat in OpenWork and keeps chatting, with no engine to choose", async ({ world, user, probe, step, evidence }) => {
  const { earlierChat, newChat } = world;
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

  await step("after: the chat saved before the update is listed in the sidebar", async () => {
    await user.see({ text: earlierChat.title }, { timeoutMs: WITHIN });
    const status = await probe.eventually(async () => record((await probe.desktopApi("/experimental/engine-v2-preview/status")).body), {
      within: WITHIN, label: "OpenWork finished copying earlier chats", until: (body) => body.historyImportPending === false,
    });
    const migration = record(status.migration);
    const copied = migration.state === "completed" && migration.imported === 1;
    const untouched = world.earlierDatabaseUntouched();
    evidence.recordAssertionEvidence("Earlier chats were copied once, and the original database was left as it was",
      `copy ${String(migration.state)}: ${String(migration.imported)} of ${String(migration.total)} chats; original still has its 1 chat: ${untouched}`, copied && untouched);
    expect(copied).toBe(true);
    expect(untouched).toBe(true);
    await user.screenshot();
  });

  await step("after: opening it shows the earlier question and answer", async () => {
    await user.click({ text: earlierChat.title });
    await user.see({ text: earlierChat.question }, { timeoutMs: 60_000 });
    await user.see({ text: earlierChat.answer }, { timeoutMs: 30_000 });
    const readable = (await probe.has(earlierChat.question)) && (await probe.has(earlierChat.answer));
    evidence.recordAssertionEvidence("The earlier chat reads like any other chat", `question "${earlierChat.question}" and answer shown`, readable);
    expect(readable).toBe(true);
    await user.screenshot();
  });

  await step("the command palette offers no engine switch and no chat migration", async () => {
    await user.press(world.paletteShortcut);
    await user.see({ role: "combobox" });
    await user.type({ role: "combobox" }, "OpenCode");
    await user.notSee({ text: "Switch to OpenCode v1" });
    await user.notSee({ text: "Switch to OpenCode v2" });
    const switchOffered = (await probe.has("Switch to OpenCode v1")) || (await probe.has("Switch to OpenCode v2"));
    await user.type({ role: "combobox" }, "Migrate", { replace: true });
    await user.notSee({ text: "Migrate chats" });
    const migrateOffered = await probe.has("Migrate chats");
    evidence.recordAssertionEvidence("Nothing in the palette switches engines or migrates chats",
      `"OpenCode" lists no engine switch: ${!switchOffered}; "Migrate" lists no Migrate chats: ${!migrateOffered}`, !switchOffered && !migrateOffered);
    expect(switchOffered).toBe(false);
    expect(migrateOffered).toBe(false);
    await user.screenshot();
    await user.press("Escape");
  });

  await step("after: a new chat gets an answer from the configured model", async () => {
    await user.click({ role: "button", label: "New session" });
    await user.see("composer", { editable: true, timeoutMs: 60_000 });
    await user.type("composer", newChat.prompt);
    await user.press("Enter");
    await user.see({ text: newChat.reply }, { timeoutMs: 60_000 });
    const requests = await world.newChatRequests();
    evidence.recordAssertionEvidence("The new chat reached the scripted model and its answer is shown", `${requests.length} model request(s); reply "${newChat.reply}" shown`, requests.length > 0);
    expect(requests.length).toBeGreaterThan(0);
    await user.screenshot();
  });
});
