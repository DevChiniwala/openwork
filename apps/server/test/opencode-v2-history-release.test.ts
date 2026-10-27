import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireEngineHistoryLease, acquireHistoryCopyLock } from "../src/opencode-v2-history-lock.js";
import { historyCopyRetry, releaseFailedHistoryCopy } from "../src/opencode-v2-migration.js";

function database(path: string, rows: string[]): void {
  const db = new Database(path);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY)");
    for (const row of rows) db.prepare("INSERT INTO session (id) VALUES (?)").run(row);
  } finally { db.close(); }
}

function sessions(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare("SELECT id FROM session ORDER BY id").all().map((row) =>
      row && typeof row === "object" && "id" in row && typeof row.id === "string" ? row.id : "");
  } finally { db.close(); }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function interruptedCopy(phase: string, backup: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "openwork-history-release-"));
  const storageDir = join(directory, "opencode-v2");
  const root = join(storageDir, "state");
  await mkdir(join(storageDir, "history-copy"), { recursive: true });
  await mkdir(root, { recursive: true });
  const targetDatabase = join(root, "opencode.db");
  const backupPath = join(storageDir, "backups", "opencode-v2-before.db");
  await mkdir(join(storageDir, "backups"), { recursive: true });
  database(backupPath, ["own-v2-chat"]);
  // The target holds the chat it had plus a partly copied one.
  database(targetDatabase, ["own-v2-chat", "partly-copied"]);
  const checkpoint = { source: join(directory, "v1.db"), target: targetDatabase, phase, sourceKey: "digest", snapshotStartedAt: 1,
    ...(backup ? { backupPath } : {}) };
  await writeFile(join(storageDir, "history-copy", "checkpoint.json"), JSON.stringify(checkpoint));
  // A failed copy leaves its pending fence behind.
  const lock = await acquireHistoryCopyLock(targetDatabase);
  await lock.release();
  return { directory, storageDir, root, targetDatabase };
}

test("a failed transfer restores v2's own chats, lifts the fence and keeps the conversion checkpoint", async () => {
  const copy = await interruptedCopy("copying", true);
  try {
    await assert.rejects(acquireEngineHistoryLease(copy.root), /incomplete/);
    await releaseFailedHistoryCopy({ storageDir: copy.storageDir, targetDatabase: copy.targetDatabase });
    assert.deepEqual(sessions(copy.targetDatabase), ["own-v2-chat"]);
    const lease = await acquireEngineHistoryLease(copy.root);
    await lease.release();
    const checkpoint: unknown = JSON.parse(await readFile(join(copy.storageDir, "history-copy", "checkpoint.json"), "utf8"));
    assert.ok(checkpoint && typeof checkpoint === "object");
    assert.equal("phase" in checkpoint && checkpoint.phase, "copying");
    assert.equal("backupPath" in checkpoint, false, "the next attempt takes a fresh backup");
  } finally { await rm(copy.directory, { recursive: true, force: true }); }
});

test("a copy that failed before writing to v2 leaves its history untouched", async () => {
  const copy = await interruptedCopy("converting", false);
  try {
    await releaseFailedHistoryCopy({ storageDir: copy.storageDir, targetDatabase: copy.targetDatabase });
    assert.deepEqual(sessions(copy.targetDatabase), ["own-v2-chat", "partly-copied"]);
    assert.equal(await exists(join(copy.root, "history-copy.pending")), false);
  } finally { await rm(copy.directory, { recursive: true, force: true }); }
});

test("a transfer without a recorded backup keeps its fence and files", async () => {
  const copy = await interruptedCopy("copying", false);
  try {
    await assert.rejects(releaseFailedHistoryCopy({ storageDir: copy.storageDir, targetDatabase: copy.targetDatabase }), /no backup/);
    assert.equal(await exists(join(copy.root, "history-copy.pending")), true);
    assert.deepEqual(sessions(copy.targetDatabase), ["own-v2-chat", "partly-copied"]);
  } finally { await rm(copy.directory, { recursive: true, force: true }); }
});

test("failed copies back off from one minute to one day", () => {
  assert.deepEqual(historyCopyRetry(0, 1000), { attempts: 1, retryAt: 61_000 });
  assert.equal(historyCopyRetry(40, 0).retryAt, 86_400_000);
});
