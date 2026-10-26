import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { browserScript } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

/** One chat a person had before the update, as the earlier engine saved it. */
const earlierChat = {
  id: "ses_0000000000000000000000hist01",
  title: "Plan the spring offsite",
  question: "Draft a one-day agenda for the spring offsite.",
  answer: "Here is a one-day agenda: a morning planning session, a team lunch, and an afternoon workshop.",
} as const;

const HISTORY_PROVIDER = { providerID: "history-mock", modelID: "history-model" } as const;
const WITNESS_PROVIDER_ID = "history-witness";
const WITNESS_MODEL_ID = "history-witness-model";

/**
 * Builds the earlier engine's chat database from its recorded schema (no
 * earlier engine binary is run): one workspace chat with a question and an
 * answer, saved for `directory`.
 */
async function seedEarlierHistory(database: string, directory: string): Promise<void> {
  const schema = await readFile(new URL("./fixtures/opencode-v1-history/schema.sql", import.meta.url), "utf8");
  const db = new DatabaseSync(database);
  try {
    db.exec(schema);
    const created = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const answered = created + 4_000;
    const userId = "msg_0000000000000000000000hist01";
    const assistantId = "msg_0000000000000000000000hist02";
    db.prepare("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/', ?, ?, '[]')").run(created, created);
    db.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (?, 'global', 'spring-offsite', ?, ?, '1.18.30', ?, ?)`).run(earlierChat.id, directory, earlierChat.title, created, answered);
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(userId, earlierChat.id, created, created,
      JSON.stringify({ role: "user", time: { created }, agent: "build", model: HISTORY_PROVIDER }));
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run("prt_0000000000000000000000hist01", userId, earlierChat.id, created, created,
      JSON.stringify({ type: "text", text: earlierChat.question }));
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(assistantId, earlierChat.id, answered, answered, JSON.stringify({
      role: "assistant", parentID: userId, time: { created: answered, completed: answered + 1 },
      modelID: HISTORY_PROVIDER.modelID, providerID: HISTORY_PROVIDER.providerID, mode: "build", agent: "build",
      path: { cwd: directory, root: directory }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop",
    }));
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run("prt_0000000000000000000000hist02", assistantId, earlierChat.id, answered, answered,
      JSON.stringify({ type: "text", text: earlierChat.answer }));
  } finally {
    db.close();
  }
}

/**
 * A person who used OpenWork before OpenCode v2 opens the updated app in a
 * browser. Their earlier chat database is in place before the server starts,
 * exactly where the earlier engine kept it (OPENCODE_DB); the server copies it
 * into OpenCode v2 on its own. A scripted model answers new chats.
 */
export async function v1HistoryCopiedToV2(seed: Seed) {
  const folder = seed.tmpPath("v1-history-workspace");
  await mkdir(folder, { recursive: true });
  // Chats are saved for the canonical folder path (macOS aliases /var and /tmp).
  const workspacePath = await realpath(folder);
  const historyDirectory = seed.tmpPath("v1-history-data");
  await mkdir(historyDirectory, { recursive: true });
  const historyDatabase = join(historyDirectory, "opencode.db");
  await seedEarlierHistory(historyDatabase, workspacePath);

  const newChat = { prompt: "Summarize what we planned. NEW-CHAT-AFTER-UPDATE", reply: "The offsite agenda is ready to share." };
  const app = await seed.appWeb({
    name: "v1-history-copied-to-v2", workspacePath, headless: true, mouse: true,
    env: {
      OPENCODE_DB: historyDatabase,
      ...(process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {}),
    },
    mocks: { agent: seed.mock({ isolatedProcessEnv: true, agentWorkloads: [
      { promptMarker: newChat.prompt, latestUserTurn: true, finalReply: newChat.reply, steps: [] },
    ] }) },
  });
  const agent = app.mocks.agent;
  if (!agent) throw new Error("The scripted model was not started");
  const workspace = await seed.workspace(app, workspacePath);
  // New chats use the scripted model, selected the way a person's saved choice is.
  await configureProvider(seed, app, workspace.workspaceId, WITNESS_PROVIDER_ID, WITNESS_MODEL_ID, {
    provider: { [WITNESS_PROVIDER_ID]: {
      npm: "@ai-sdk/openai-compatible", name: "History witness",
      options: { baseURL: `${agent.url}/v1`, apiKey: "sk-history-witness-only" },
      models: { [WITNESS_MODEL_ID]: { name: "History witness model" } },
    } },
  });
  // Read the browser's platform; it only selects the native palette shortcut.
  const paletteShortcut = await seed.evalIn(app, browserScript(() =>
    /Mac/i.test(navigator.platform) ? "Meta+K" : "Control+K", []));
  return {
    app, workspace, workspacePath, earlierChat, newChat, paletteShortcut,
    /** The earlier chat database is never written by the copy. */
    earlierDatabaseUntouched() {
      const db = new DatabaseSync(historyDatabase, { readOnly: true });
      try {
        const row: unknown = db.prepare("SELECT count(*) AS sessions FROM session").get();
        return typeof row === "object" && row !== null && "sessions" in row && row.sessions === 1;
      } finally {
        db.close();
      }
    },
    /** Model requests that reached the scripted model for the new chat. */
    newChatRequests: async () => (await agent.agentRequests({ promptMarker: newChat.prompt })).filter((request) => request.kind === "final"),
  };
}
