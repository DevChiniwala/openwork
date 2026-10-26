import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import type { BlobStore } from "./blobs.js"
import { mediaTypeFor } from "./saved-files.js"
import type { SqlDriver, SqlValue } from "./sql.js"
import { formatBytes } from "./tool-files.js"

/**
 * My files: one file space per member, shared by every conversation of theirs that asks for it (`memberFiles: true`),
 * by its computer (mirrored at /files, see @openwork-ee/headless-computer) and so by its browser. See
 * docs/features/member-files/README.md.
 *
 * - The space is named server-side (`member:<owner>`), never by the model or a browser.
 * - Rows (`member_files`) have no session_id: deleting or moving a conversation never touches them.
 * - Bytes live in the runner's file store under `members/<sha256(owner)[:40]>/`, one object per version, so a write
 *   from another cell (bytes first, then the row) never changes an object someone may be reading.
 */

/** The folder tool paths name My files by: `/files/...` or `files/...`. */
export const MEMBER_FILES_ROOT = "files"
export const MAX_MEMBER_PATH = 512
const MAX_NAME = 255

export type MemberFileLimits = { maxFileBytes: number; maxMemberBytes: number; maxFiles: number }
export const DEFAULT_MEMBER_FILE_LIMITS: MemberFileLimits = { maxFileBytes: 100 * 1024 * 1024, maxMemberBytes: 10 * 1024 * 1024 * 1024, maxFiles: 10_000 }

export const memberFileKind = z.enum(["upload", "agent", "browser", "computer"])
export type MemberFileKind = z.infer<typeof memberFileKind>
/** Who wrote a version: what kind of surface, and the conversation and message, when a turn did. */
export type MemberFileWriter = { kind: MemberFileKind; agent?: string | null; sessionId?: string | null; messageId?: string | null; url?: string | null }

export const memberFileSchema = z.object({
  id: z.string(),
  /** Inside the space, without `/files/`: `Downloads/report.pdf`. */
  path: z.string(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number(),
  /** 1 for the first version, one more for each later one: what the computer's sync compares. */
  version: z.number(),
  /** Where the file came from (its first version), for "where did this come from". */
  origin: z.object({ kind: memberFileKind, agent: z.string().nullable(), url: z.string().nullable() }),
  /** Who wrote the current version; a turn's answer shows the files it wrote. */
  lastWriter: z.object({ kind: memberFileKind, sessionId: z.string().nullable(), messageId: z.string().nullable() }),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type MemberFile = z.infer<typeof memberFileSchema>
export type StoredMemberFile = MemberFile & { storageKey: string }

export type MemberFileErrorCode = "invalid_path" | "file_too_large" | "files_full" | "too_many_files" | "conflict" | "path_conflict" | "not_allowed" | "not_found"

/** A refused change; `message` is written for the model and the person. */
export class MemberFileError extends Error {
  constructor(
    readonly code: MemberFileErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "MemberFileError"
  }
}

/** The owner's cell holding My files didn't answer (celld): a change's outcome is unknown. */
export class MemberFilesUnavailableError extends Error {
  constructor() {
    super("member_files_unavailable")
    this.name = "MemberFilesUnavailableError"
  }
}

/** The space of one member's files. */
export const memberSpace = (owner: string) => `member:${owner}`
/** The store prefix of a space's objects: hashed, since owners hold characters a key can't. */
export const memberStoragePrefix = (space: string) => `members/${createHash("sha256").update(space).digest("hex").slice(0, 40)}/`

/**
 * A path inside My files: segments joined with `/`, no `.`/`..`, no control characters, at most 512 characters (255 per
 * name). Null when it can't be one.
 */
export function normalizeMemberPath(input: string): string | null {
  const parts = input.replaceAll("\\", "/").split("/").filter((part) => part && part !== ".")
  if (parts.length === 0 || parts.some((part) => part === ".." || part.length > MAX_NAME || part.trim() !== part || !part.trim())) return null
  const path = parts.join("/")
  if (path.length > MAX_MEMBER_PATH || /[\u0000-\u001f\u007f]/.test(path)) return null
  return path
}

/** A folder inside My files ("" for its top), or null. */
export function normalizeMemberFolder(input: string): string | null {
  const trimmed = input.replaceAll("\\", "/").split("/").filter((part) => part && part !== ".").join("/")
  if (!trimmed) return ""
  return normalizeMemberPath(trimmed)
}

/**
 * The path inside My files that a tool path names (`/files/x`, `files/x`), "" for My files itself, or null for any
 * other path (the scratch workspace).
 */
export function memberPathOf(input: string): string | null {
  const parts = input.trim().replaceAll("\\", "/").split("/").filter((part) => part && part !== ".")
  if (parts[0] !== MEMBER_FILES_ROOT) return null
  if (parts.length === 1) return ""
  return normalizeMemberPath(parts.slice(1).join("/")) ?? null
}

/** Whether a tool path is under /files at all, valid or not (so an invalid one is refused, not written to scratch). */
export function namesMemberFiles(input: string) {
  return input.trim().replaceAll("\\", "/").split("/").filter((part) => part && part !== ".")[0] === MEMBER_FILES_ROOT
}

export const shownPath = (path: string) => (path ? `/${MEMBER_FILES_ROOT}/${path}` : `/${MEMBER_FILES_ROOT}/`)
/** A folder as the model sees it, with its trailing slash. */
export const shownFolder = (folder: string) => (folder ? `${shownPath(folder)}/` : shownPath(""))
export const agentFolder = (agent: string) => `agents/${agent}`
export const AGENT_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/

/** Whether `path` is `folder` or inside it ("" is everything). */
export function isInside(path: string, folder: string) {
  return folder === "" || path === folder || path.startsWith(`${folder}/`)
}

// ---------------------------------------------------------------------------------------------------- the index

/** What a write changes in the index. `ifVersion`: null = the path must be free, a number = its current version. */
export type MemberFileCommit = {
  path: string
  size: number
  mediaType: string
  storageKey: string
  writer: MemberFileWriter
  ifVersion?: number | null
  limits: MemberFileLimits
}
export type MemberFileCommitResult = { ok: true; file: StoredMemberFile; replacedKey: string | null } | { ok: false; code: MemberFileErrorCode; message: string }
export type MemberFileLookup = { path: string } | { id: string }
export type MemberFileListing = { prefix?: string; sessionId?: string }

/**
 * Where a space's rows are kept: this database (Node, an owner cell), or the owner's cell (a chat in its own cell, see
 * cells.ts). Every call names the space; a remote index answers only its own owner's.
 */
export type MemberFileIndex = {
  list(space: string, listing?: MemberFileListing): Promise<StoredMemberFile[]>
  get(space: string, lookup: MemberFileLookup): Promise<StoredMemberFile | null>
  usage(space: string): Promise<{ bytes: number; files: number }>
  commit(space: string, commit: MemberFileCommit): Promise<MemberFileCommitResult>
  remove(space: string, lookup: MemberFileLookup, ifVersion?: number): Promise<{ ok: true; storageKey: string } | { ok: false; code: "not_found" | "conflict" }>
}

/** Migration 4: the member_files table. Not a conversation table: no session_id, never copied or exported with one. */
export function migrateMemberFiles(db: SqlDriver) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS member_files (
      space TEXT NOT NULL,
      id TEXT NOT NULL,
      path TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      version INTEGER NOT NULL,
      storage_key TEXT NOT NULL,
      origin_kind TEXT NOT NULL,
      origin_agent TEXT,
      origin_url TEXT,
      last_kind TEXT NOT NULL,
      last_session TEXT,
      last_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (space, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS member_files_by_path ON member_files (space, path);
    CREATE INDEX IF NOT EXISTS member_files_by_session ON member_files (space, last_session);
  `)
}

const memberRow = z.object({
  id: z.string(),
  path: z.string(),
  media_type: z.string(),
  size: z.number(),
  version: z.number(),
  storage_key: z.string(),
  origin_kind: memberFileKind,
  origin_agent: z.string().nullable(),
  origin_url: z.string().nullable(),
  last_kind: memberFileKind,
  last_session: z.string().nullable(),
  last_message: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
})
const usageRow = z.object({ bytes: z.number().nullable(), files: z.number() })

const nameOf = (path: string) => path.split("/").pop() ?? path

function fromRow(row: unknown): StoredMemberFile {
  const value = memberRow.parse(row)
  return {
    id: value.id,
    path: value.path,
    name: nameOf(value.path),
    mediaType: value.media_type,
    size: value.size,
    version: value.version,
    origin: { kind: value.origin_kind, agent: value.origin_agent, url: value.origin_url },
    lastWriter: { kind: value.last_kind, sessionId: value.last_session, messageId: value.last_message },
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    storageKey: value.storage_key,
  }
}

const COLUMNS = "id, path, media_type, size, version, storage_key, origin_kind, origin_agent, origin_url, last_kind, last_session, last_message, created_at, updated_at"

/** Paths of a file's folders: `a/b/c` → `a`, `a/b`. */
const ancestors = (path: string) => path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"))

/** The index in this database, in one transaction per change (`atomic`: the Store's, so it nests in its own). */
export function localMemberFileIndex(db: SqlDriver, atomic: <T>(fn: () => T) => T, now: () => number = Date.now): MemberFileIndex {
  const byLookup = (space: string, lookup: MemberFileLookup) =>
    "id" in lookup
      ? db.prepare(`SELECT ${COLUMNS} FROM member_files WHERE space = ? AND id = ?`).get(space, lookup.id)
      : db.prepare(`SELECT ${COLUMNS} FROM member_files WHERE space = ? AND path = ?`).get(space, lookup.path)
  const usage = (space: string) => {
    const value = usageRow.parse(db.prepare("SELECT SUM(size) AS bytes, COUNT(*) AS files FROM member_files WHERE space = ?").get(space))
    return { bytes: value.bytes ?? 0, files: value.files }
  }
  return {
    async list(space, listing = {}) {
      const where = ["space = ?"]
      const params: SqlValue[] = [space]
      if (listing.prefix) {
        where.push("(path = ? OR substr(path, 1, ?) = ?)")
        params.push(listing.prefix, listing.prefix.length + 1, `${listing.prefix}/`)
      }
      if (listing.sessionId) {
        where.push("last_session = ?")
        params.push(listing.sessionId)
      }
      return db.prepare(`SELECT ${COLUMNS} FROM member_files WHERE ${where.join(" AND ")} ORDER BY path`).all(...params).map(fromRow)
    },
    async get(space, lookup) {
      const row = byLookup(space, lookup)
      return row ? fromRow(row) : null
    },
    async usage(space) {
      return usage(space)
    },
    async commit(space, commit) {
      return atomic((): MemberFileCommitResult => {
        const row = byLookup(space, { path: commit.path })
        const existing = row ? fromRow(row) : null
        if (commit.ifVersion !== undefined && (commit.ifVersion === null ? existing !== null : existing?.version !== commit.ifVersion)) {
          return { ok: false, code: "conflict", message: `${shownPath(commit.path)} changed since it was read. Read it again before changing it.` }
        }
        if (!existing) {
          // A file and a folder can't share a name: the computer's /files is a real file system.
          const folderTaken = ancestors(commit.path).find((folder) => db.prepare("SELECT 1 AS n FROM member_files WHERE space = ? AND path = ?").get(space, folder) !== undefined)
          if (folderTaken !== undefined) return { ok: false, code: "path_conflict", message: `${shownPath(folderTaken)} is a file, so it can't hold other files. Choose another folder.` }
          const isFolder = db.prepare("SELECT 1 AS n FROM member_files WHERE space = ? AND substr(path, 1, ?) = ? LIMIT 1").get(space, commit.path.length + 1, `${commit.path}/`)
          if (isFolder !== undefined) return { ok: false, code: "path_conflict", message: `${shownPath(commit.path)} is a folder. Choose a file name inside it.` }
        }
        const used = usage(space)
        if (!existing && used.files >= commit.limits.maxFiles) {
          return { ok: false, code: "too_many_files", message: `My files already has ${commit.limits.maxFiles.toLocaleString("en-US")} files. Delete some to make room.` }
        }
        const after = used.bytes - (existing?.size ?? 0) + commit.size
        if (after > commit.limits.maxMemberBytes) {
          return {
            ok: false,
            code: "files_full",
            message: `My files is full (${formatBytes(used.bytes)} of ${formatBytes(commit.limits.maxMemberBytes)}). Delete some files to make room.`,
          }
        }
        const at = now()
        const writer = commit.writer
        if (existing) {
          db.prepare(
            "UPDATE member_files SET media_type = ?, size = ?, version = version + 1, storage_key = ?, last_kind = ?, last_session = ?, last_message = ?, updated_at = ? WHERE space = ? AND id = ?",
          ).run(commit.mediaType, commit.size, commit.storageKey, writer.kind, writer.sessionId ?? null, writer.messageId ?? null, at, space, existing.id)
        } else {
          db.prepare(`INSERT INTO member_files (space, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            space,
            `mf_${randomUUID().replaceAll("-", "")}`,
            commit.path,
            commit.mediaType,
            commit.size,
            commit.storageKey,
            writer.kind,
            writer.agent ?? null,
            writer.url ?? null,
            writer.kind,
            writer.sessionId ?? null,
            writer.messageId ?? null,
            at,
            at,
          )
        }
        const saved = byLookup(space, { path: commit.path })
        if (!saved) throw new Error("member_file_missing_after_commit")
        return { ok: true, file: fromRow(saved), replacedKey: existing?.storageKey ?? null }
      })
    },
    async remove(space, lookup, ifVersion) {
      return atomic(() => {
        const row = byLookup(space, lookup)
        if (!row) return { ok: false as const, code: "not_found" as const }
        const file = fromRow(row)
        if (ifVersion !== undefined && file.version !== ifVersion) return { ok: false as const, code: "conflict" as const }
        db.prepare("DELETE FROM member_files WHERE space = ? AND id = ?").run(space, file.id)
        return { ok: true as const, storageKey: file.storageKey }
      })
    },
  }
}

// ---------------------------------------------------------------------------------------------------- files

/** Without the store key: what leaves the runner. */
export const publicFile = (file: StoredMemberFile): MemberFile => {
  const { storageKey: _key, ...rest } = file
  return rest
}

/** A space's files: rows in the index, bytes in the file store. */
export class MemberFiles {
  constructor(
    readonly index: MemberFileIndex,
    readonly blobs: BlobStore,
    readonly limits: MemberFileLimits,
  ) {}

  list(space: string, listing?: MemberFileListing) {
    return this.index.list(space, listing)
  }

  get(space: string, lookup: MemberFileLookup) {
    return this.index.get(space, lookup)
  }

  usage(space: string) {
    return this.index.usage(space)
  }

  async read(space: string, lookup: MemberFileLookup): Promise<{ file: StoredMemberFile; bytes: Uint8Array<ArrayBuffer> } | null> {
    const file = await this.index.get(space, lookup)
    if (!file) return null
    const bytes = await this.blobs.get(file.storageKey)
    return bytes ? { file, bytes } : null
  }

  /** Writes a version (bytes first, then the row); throws MemberFileError when it is refused. */
  async write(space: string, path: string, bytes: Uint8Array<ArrayBuffer>, input: { writer: MemberFileWriter; mediaType?: string | null; ifVersion?: number | null }): Promise<StoredMemberFile> {
    const normalized = normalizeMemberPath(path)
    if (normalized === null || normalized !== path) throw new MemberFileError("invalid_path", `${shownPath(path)} isn't a valid file name.`)
    if (bytes.byteLength > this.limits.maxFileBytes) {
      throw new MemberFileError("file_too_large", `That file is ${formatBytes(bytes.byteLength)}; the most a file in My files can be is ${formatBytes(this.limits.maxFileBytes)}.`)
    }
    const mediaType = mediaTypeFor(nameOf(path), input.mediaType)
    const storageKey = `${memberStoragePrefix(space)}${randomUUID().replaceAll("-", "")}`
    await this.blobs.put(storageKey, bytes, mediaType)
    // If the owner's cell doesn't answer, the row's fate is unknown: the object stays (at worst an orphan) and the
    // error reaches the caller, which says the outcome is unknown.
    const result = await this.index.commit(space, { path, size: bytes.byteLength, mediaType, storageKey, writer: input.writer, ...(input.ifVersion !== undefined ? { ifVersion: input.ifVersion } : {}), limits: this.limits })
    if (!result.ok) {
      await this.blobs.delete(storageKey).catch(() => undefined)
      throw new MemberFileError(result.code, result.message)
    }
    if (result.replacedKey) await this.blobs.delete(result.replacedKey).catch(() => undefined)
    return result.file
  }

  /** Deletes a file (only that version, with `ifVersion`); false when there is none (or it changed). */
  async delete(space: string, lookup: MemberFileLookup, ifVersion?: number): Promise<{ ok: true } | { ok: false; code: "not_found" | "conflict" }> {
    const removed = await this.index.remove(space, lookup, ifVersion)
    if (!removed.ok) return removed
    await this.blobs.delete(removed.storageKey).catch(() => undefined)
    return { ok: true }
  }
}

// ---------------------------------------------------------------------------------------------------- one run's access

/**
 * What one turn may do in a space. `writeRoot`: null writes anywhere, a folder writes only inside it (a background
 * or read-only run's agent folder), false writes nothing (a task's report, a background run without an agent).
 */
export type MemberFilesScope = {
  space: string
  writeRoot: string | null | false
  writer: { agent: string | null; sessionId: string; messageId: string | null }
}

export type MemberWriteResult =
  | { ok: true; file: StoredMemberFile }
  | { ok: false; code: MemberFileErrorCode; message: string }

/** A turn's view of My files, for the file tools and the computer's sync (paths inside the space). */
export class MemberFilesAccess {
  constructor(
    readonly files: MemberFiles,
    readonly scope: MemberFilesScope,
  ) {}

  get maxFileBytes() {
    return this.files.limits.maxFileBytes
  }

  canWrite(path: string) {
    const root = this.scope.writeRoot
    return root !== false && (root === null || isInside(path, root))
  }

  /** Why this run can't change `path`, for the model. */
  refusal(path: string) {
    const root = this.scope.writeRoot
    if (root === false) return `This run can read My files but can't change them, so ${shownPath(path)} was not changed.`
    return `This run can only save in ${shownFolder(root ?? "")}, so ${shownPath(path)} was not changed.`
  }

  list(listing?: MemberFileListing) {
    return this.files.list(this.scope.space, listing)
  }

  get(path: string) {
    return this.files.get(this.scope.space, { path })
  }

  usage() {
    return this.files.usage(this.scope.space)
  }

  read(path: string) {
    return this.files.read(this.scope.space, { path })
  }

  async write(path: string, bytes: Uint8Array<ArrayBuffer>, input: { kind: MemberFileKind; ifVersion?: number | null; mediaType?: string | null; url?: string | null }): Promise<MemberWriteResult> {
    if (!this.canWrite(path)) return { ok: false, code: "not_allowed", message: this.refusal(path) }
    try {
      const file = await this.files.write(this.scope.space, path, bytes, {
        writer: { kind: input.kind, agent: this.scope.writer.agent, sessionId: this.scope.writer.sessionId, messageId: this.scope.writer.messageId, url: input.url ?? null },
        ...(input.mediaType !== undefined ? { mediaType: input.mediaType } : {}),
        ...(input.ifVersion !== undefined ? { ifVersion: input.ifVersion } : {}),
      })
      return { ok: true, file }
    } catch (error) {
      if (error instanceof MemberFileError) return { ok: false, code: error.code, message: error.message }
      throw error
    }
  }

  async delete(path: string, ifVersion?: number): Promise<{ ok: true } | { ok: false; code: "not_allowed" | "not_found" | "conflict"; message: string }> {
    if (!this.canWrite(path)) return { ok: false, code: "not_allowed", message: this.refusal(path) }
    const deleted = await this.files.delete(this.scope.space, { path }, ifVersion)
    if (deleted.ok) return deleted
    return deleted.code === "not_found"
      ? { ok: false, code: "not_found", message: `There is no file at ${shownPath(path)}.` }
      : { ok: false, code: "conflict", message: `${shownPath(path)} changed since it was read, so it was kept.` }
  }
}

// ---------------------------------------------------------------------------------------------------- who may write

/**
 * A turn's access to its owner's files, or null when the conversation didn't ask for them (or has no owner, or the
 * runner has no file store). A person's message writes anywhere; a background task, a read-only turn or any turn of a
 * `background` conversation writes only in its agent folder (nothing without one); a task's report writes nothing.
 */
export function memberScopeFor(
  session: { id: string; owner: string | null; memberFiles: boolean; agent: string | null; background: boolean },
  turn: { kind: "message" | "task" | "report"; readOnly: boolean; messageId: string | null },
): MemberFilesScope | null {
  if (!session.memberFiles || !session.owner) return null
  const unattended = turn.kind === "task" || turn.readOnly || session.background
  const writeRoot: string | null | false = turn.kind === "report" ? false : unattended ? (session.agent ? agentFolder(session.agent) : false) : null
  return { space: memberSpace(session.owner), writeRoot, writer: { agent: session.agent, sessionId: session.id, messageId: turn.messageId } }
}
