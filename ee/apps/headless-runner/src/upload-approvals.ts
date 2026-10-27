import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { SqlDriver } from "./sql.js"

/**
 * The person's approval for the browser to upload files from My files to a site (docs/features/member-files). A page
 * can prompt-inject the agent, so an upload never dispatches until the person approved those files for that site: the
 * runner records what the agent asked for (pending), the caller (Workbot) shows it and records the person's answer,
 * and an approval holds for a short while for exactly those files and that site. The model can't approve anything.
 */

/** How long an approval lets the agent upload those files to that site. */
export const UPLOAD_APPROVAL_MS = 15 * 60_000

export type UploadApproval = { id: string; paths: string[]; host: string; state: "pending" | "approved" | "declined"; messageId: string | null; createdAt: number; decidedAt: number | null }

/** Part of migration 4 (member-files): one conversation's asks and answers, deleted with it. */
export function migrateUploadApprovals(db: SqlDriver) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS upload_approvals (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      paths TEXT NOT NULL,
      host TEXT NOT NULL,
      state TEXT NOT NULL,
      message_id TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      PRIMARY KEY (session_id, id)
    );
  `)
}

const row = z.object({ id: z.string(), paths: z.string(), host: z.string(), state: z.enum(["pending", "approved", "declined"]), message_id: z.string().nullable(), created_at: z.number(), decided_at: z.number().nullable() })
const pathsOf = (text: string) => z.array(z.string()).catch([]).parse(JSON.parse(text))
const fromRow = (value: unknown): UploadApproval => {
  const parsed = row.parse(value)
  return { id: parsed.id, paths: pathsOf(parsed.paths), host: parsed.host, state: parsed.state, messageId: parsed.message_id, createdAt: parsed.created_at, decidedAt: parsed.decided_at }
}
const sameSet = (left: string[], right: string[]) => left.length === right.length && left.every((path) => right.includes(path))

/** A conversation's pending asks, oldest first. */
export function pendingUploadApprovals(db: SqlDriver, sessionId: string): UploadApproval[] {
  return db.prepare("SELECT id, paths, host, state, message_id, created_at, decided_at FROM upload_approvals WHERE session_id = ? AND state = 'pending' ORDER BY created_at").all(sessionId).map(fromRow)
}

/** Records the person's answer to a pending ask; false when there is none by that id. */
export function decideUploadApproval(db: SqlDriver, sessionId: string, id: string, decision: "approve" | "decline", now: number) {
  return Number(db.prepare("UPDATE upload_approvals SET state = ?, decided_at = ? WHERE session_id = ? AND id = ? AND state = 'pending'").run(decision === "approve" ? "approved" : "declined", now, sessionId, id).changes) > 0
}

/** One run's view: which sites it may upload these files to, and asking for one it may not. */
export function uploadApprovalsFor(db: SqlDriver, sessionId: string, messageId: string | null, now: () => number = Date.now) {
  return {
    async approvedHosts(paths: string[]) {
      const since = now() - UPLOAD_APPROVAL_MS
      const approved = db.prepare("SELECT id, paths, host, state, message_id, created_at, decided_at FROM upload_approvals WHERE session_id = ? AND state = 'approved' AND decided_at >= ?").all(sessionId, since).map(fromRow)
      return [...new Set(approved.filter((approval) => paths.every((path) => approval.paths.includes(path))).map((approval) => approval.host))]
    },
    async request(paths: string[], host: string) {
      const open = pendingUploadApprovals(db, sessionId).find((approval) => approval.host === host && sameSet(approval.paths, paths))
      if (open) return open.id
      const id = `ua_${randomUUID().replaceAll("-", "")}`
      db.prepare("INSERT INTO upload_approvals (session_id, id, paths, host, state, message_id, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)").run(sessionId, id, JSON.stringify(paths), host, messageId, now())
      return id
    },
  }
}
