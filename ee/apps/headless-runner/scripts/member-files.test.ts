/**
 * My files (src/member-files.ts, src/member-file-tools.ts): one space per member, shared by their conversations,
 * reached with the same file tools at /files, scoped so background and read-only runs only save in their agent folder,
 * kept when a conversation is deleted, and invisible to anyone else.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { createApp } from "../src/app.js"
import { CellsStore } from "../src/cells-store.js"
import { CellCallError, SessionCells, ownerCellName, sessionCellName, type CellCall, type CellIdentity } from "../src/cells.js"
import { FILE_TOOLS } from "../src/files.js"
import { MEMBER_FILE_TOOLS } from "../src/member-file-tools.js"
import {
  DEFAULT_MEMBER_FILE_LIMITS,
  localMemberFileIndex,
  memberPathOf,
  MemberFiles,
  MemberFilesAccess,
  memberScopeFor,
  memberSpace,
  normalizeMemberPath,
  type MemberFileLimits,
} from "../src/member-files.js"
import type { ModelClient, ModelRequest, ModelStep } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import { SavedFiles } from "../src/saved-files.js"
import { Store } from "../src/store.js"
import type { Message, ToolCall } from "../src/types.js"
import { pendingUploadApprovals, uploadApprovalsFor } from "../src/upload-approvals.js"
import { memoryBlobs } from "./storage-fixture.js"

const token = "test-token-0123456789-0123456789-0123456789"
const owner = "wb:member-a"
const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }
const limits = { maxConcurrentTurns: 4, maxSteps: 10, turnTimeoutMs: Number.POSITIVE_INFINITY, credentialRefreshMs: Number.POSITIVE_INFINITY, contextCharBudget: 100_000 }

const resultsOf = (request: ModelRequest) => {
  const index = request.messages.findLastIndex((message) => message.role === "user")
  return request.messages.slice(index + 1).filter((message): message is Extract<Message, { role: "tool" }> => message.role === "tool")
}

/** A model that makes one tool call per step, from `calls`, then answers with the last result it saw. */
function scripted(calls: Array<Omit<ToolCall, "id">>, seen: ModelRequest[] = []): ModelClient {
  return {
    async complete(request): Promise<ModelStep> {
      seen.push(request)
      const results = resultsOf(request)
      const next = calls[results.length]
      if (next) return { text: "", toolCalls: [{ id: `call_${results.length}`, ...next }], usage }
      return { text: `Done: ${results.at(-1)?.output ?? ""}`, toolCalls: [], usage }
    },
  }
}

function world(input: { limits?: Partial<MemberFileLimits>; files?: boolean } = {}) {
  const store = new Store(nodeSqlite(":memory:"))
  const bucket = memoryBlobs()
  const memberFiles = new MemberFiles(localMemberFileIndex(store.db, (fn) => store.transaction(fn)), bucket.store, { ...DEFAULT_MEMBER_FILE_LIMITS, ...input.limits })
  const files = input.files ? new SavedFiles(store, bucket.store, { maxFileBytes: 1024 * 1024, maxSessionBytes: 10 * 1024 * 1024 }) : undefined
  const runnerWith = (model: ModelClient) => new Runner({ store, model, defaultModel: "test-model", defaultModelApiKey: "test-key", limits, memberFiles, ...(files ? { files } : {}) })
  const app = (runner: Runner) => createApp({ store, runner, apiToken: token, memberFiles, ...(files ? { files } : {}) })
  /** Runs one turn of `calls` in a session and returns the tool results the model saw, in order. */
  async function turn(sessionId: string, calls: Array<Omit<ToolCall, "id">>, options: { readOnly?: boolean; seen?: ModelRequest[] } = {}) {
    const seen = options.seen ?? []
    const runner = runnerWith(scripted(calls, seen))
    const messageId = `msg_${Math.random().toString(36).slice(2, 10)}`
    const sent = runner.send({ sessionId, messageId, prompt: "go", credentials: options.readOnly ? { readOnly: true } : {} })
    assert.equal(sent.ok, true)
    await runner.idle()
    return { results: resultsOf(seen.at(-1) ?? { messages: [], system: "", model: "", tools: [] }), seen, messageId }
  }
  return { store, bucket, memberFiles, runnerWith, app, turn, [Symbol.dispose]: () => store.close() }
}

const read = (path: string) => ({ name: "read_file", input: { path } })
const write = (path: string, content: string) => ({ name: "write_file", input: { path, content } })

test("a member's chats share one My files: written in one chat, read in another, with where it came from", async () => {
  using w = world()
  const first = w.store.createSession({ owner, memberFiles: true, agent: "workbot" })
  const second = w.store.createSession({ owner, memberFiles: true, agent: "workbot" })
  const wrote = await w.turn(first.id, [write("/files/Plans/q4.md", "Ship My files")])
  assert.equal(wrote.results[0]?.isError, false)
  assert.match(wrote.results[0]?.output ?? "", /Saved \/files\/Plans\/q4\.md/)
  const seen = await w.turn(second.id, [read("files/Plans/q4.md"), { name: "list_files", input: { path: "/files" } }])
  assert.equal(seen.results[0]?.output, "Ship My files")
  assert.match(seen.results[1]?.output ?? "", /\/files\/Plans\/\t1 file/)
  const [file] = await w.memberFiles.list(memberSpace(owner))
  assert.equal(file?.origin.kind, "agent")
  assert.equal(file?.origin.agent, "workbot")
  assert.equal(file?.lastWriter.sessionId, first.id)
  assert.equal(file?.lastWriter.messageId, wrote.messageId)
  // The scratch workspace stays the conversation's own.
  assert.equal(w.store.readFile(first.id, "files/Plans/q4.md"), null)
  // The model is told where My files are and to link what it makes; its list_files takes a folder.
  const request = seen.seen[0]
  assert.match(request?.system ?? "", /My files.*\/files/)
  assert.match(request?.system ?? "", /\[report\.pdf\]\(\/files\/Downloads\/report\.pdf\)/)
  assert.deepEqual(request?.tools.find((tool) => tool.name === "list_files")?.inputSchema, MEMBER_FILE_TOOLS[0]?.inputSchema)
})

test("a conversation that didn't ask for My files keeps its scratch files, plain tools and prompt", async () => {
  using w = world()
  const session = w.store.createSession({ owner })
  const done = await w.turn(session.id, [write("/files/x.md", "scratch"), read("files/x.md")])
  assert.equal(done.results[1]?.output, "scratch")
  assert.equal(w.store.readFile(session.id, "files/x.md"), "scratch")
  assert.deepEqual(await w.memberFiles.list(memberSpace(owner)), [])
  assert.deepEqual(done.seen[0]?.tools.filter((tool) => FILE_TOOLS.some((plain) => plain.name === tool.name)), FILE_TOOLS)
  assert.doesNotMatch(done.seen[0]?.system ?? "", /My files/)
})

test("background and read-only runs read everything but save only in their agent folder", async () => {
  using w = world()
  const space = memberSpace(owner)
  await w.memberFiles.write(space, "Downloads/invoice.txt", new Uint8Array(Buffer.from("total 42")), { writer: { kind: "browser" } })
  // A read-only turn (Workbot's context and greeting turns): reads, saves in agents/workbot/ only.
  const chat = w.store.createSession({ owner, memberFiles: true, agent: "workbot" })
  const quiet = await w.turn(chat.id, [read("/files/Downloads/invoice.txt"), write("/files/agents/workbot/notes.md", "invoice: 42"), write("/files/summary.md", "nope"), { name: "write_file", input: { path: "scratch.md", content: "nope" } }], { readOnly: true })
  assert.equal(quiet.results[0]?.output, "total 42")
  assert.equal(quiet.results[1]?.isError, false)
  assert.equal(quiet.results[2]?.isError, true)
  assert.match(quiet.results[2]?.output ?? "", /only save in \/files\/agents\/workbot\//)
  assert.match(quiet.results[3]?.output ?? "", /read_only_turn/)
  assert.match(quiet.seen[0]?.system ?? "", /only save in \/files\/agents\/workbot\//)
  // A background conversation (an Automation) without an agent can only read.
  const automation = w.store.createSession({ owner, memberFiles: true, background: true })
  const unattended = await w.turn(automation.id, [write("/files/agents/workbot/x.md", "nope"), read("/files/agents/workbot/notes.md")])
  assert.match(unattended.results[0]?.output ?? "", /can read My files but can't change them/)
  assert.equal(unattended.results[1]?.output, "invoice: 42")
  assert.deepEqual((await w.memberFiles.list(space)).map((file) => file.path), ["Downloads/invoice.txt", "agents/workbot/notes.md"])
  // The rule itself: a task writes only in its agent folder, a report nowhere, a person's message anywhere.
  const session = { id: "hs_x", owner, memberFiles: true, agent: "workbot", background: false }
  assert.equal(memberScopeFor(session, { kind: "message", readOnly: false, messageId: "m" })?.writeRoot, null)
  assert.equal(memberScopeFor(session, { kind: "task", readOnly: false, messageId: "m.t1" })?.writeRoot, "agents/workbot")
  assert.equal(memberScopeFor(session, { kind: "report", readOnly: true, messageId: "m.t1.r" })?.writeRoot, false)
  assert.equal(memberScopeFor({ ...session, owner: null }, { kind: "message", readOnly: false, messageId: "m" }), null)
})

test("paths can't escape My files, and a file and a folder can't share a name", async () => {
  assert.equal(memberPathOf("/files/a/b.txt"), "a/b.txt")
  assert.equal(memberPathOf("files"), "")
  assert.equal(memberPathOf("filesystem/a"), null)
  assert.equal(memberPathOf("/files/../etc/passwd"), null)
  assert.equal(memberPathOf("/files/a/../../b"), null)
  assert.equal(normalizeMemberPath("a\u0000b"), null)
  assert.equal(normalizeMemberPath(`${"x".repeat(256)}.txt`), null)
  using w = world()
  const session = w.store.createSession({ owner, memberFiles: true })
  const done = await w.turn(session.id, [write("/files/../escape.md", "x"), write("/files/report", "a file"), write("/files/report/inside.md", "x"), write("/files/Docs/a.md", "x"), write("/files/Docs", "x")])
  assert.match(done.results[0]?.output ?? "", /isn't a file in \/files/)
  assert.equal(done.results[1]?.isError, false)
  assert.match(done.results[2]?.output ?? "", /\/files\/report is a file/)
  assert.equal(done.results[3]?.isError, false)
  assert.match(done.results[4]?.output ?? "", /\/files\/Docs is a folder/)
  assert.equal(w.store.listFiles(session.id).length, 0, "nothing under /files ever lands in the scratch workspace")
})

test("limits per file and per member come back as sentences the model can pass on", async () => {
  using w = world({ limits: { maxFileBytes: 64, maxMemberBytes: 100 } })
  const session = w.store.createSession({ owner, memberFiles: true })
  const done = await w.turn(session.id, [write("/files/big.txt", "x".repeat(65)), write("/files/a.txt", "x".repeat(60)), write("/files/b.txt", "x".repeat(60))])
  assert.match(done.results[0]?.output ?? "", /That file is 65 bytes; the most a file in My files can be is 64 bytes\./)
  assert.equal(done.results[1]?.isError, false)
  assert.match(done.results[2]?.output ?? "", /My files is full \(60 bytes of 100 bytes\)\. Delete some files to make room\./)
  // A refused write leaves no object behind.
  assert.equal(w.bucket.keys("members/").length, 1)
})

test("edits only apply to the version they read, and a replaced version's bytes are deleted", async () => {
  using w = world()
  const space = memberSpace(owner)
  const access = new MemberFilesAccess(w.memberFiles, { space, writeRoot: null, writer: { agent: null, sessionId: "hs_a", messageId: null } })
  const first = await access.write("notes.md", new Uint8Array(Buffer.from("v1")), { kind: "agent" })
  assert.ok(first.ok)
  const second = await access.write("notes.md", new Uint8Array(Buffer.from("v2")), { kind: "browser", ifVersion: 1 })
  assert.ok(second.ok && second.file.version === 2)
  const stale = await access.write("notes.md", new Uint8Array(Buffer.from("v1 edit")), { kind: "browser", ifVersion: 1 })
  assert.equal(stale.ok, false)
  assert.equal(stale.ok ? "" : stale.code, "conflict")
  assert.equal(Buffer.from((await access.read("notes.md"))?.bytes ?? []).toString(), "v2")
  assert.equal(w.bucket.keys("members/").length, 1, "one object per file: the replaced version is gone")
  assert.equal((await access.delete("notes.md", 1)).ok, false, "a delete of an older version keeps the newer one")
})

test("a PDF in My files reaches the model the way open_file shows it, and save_file hands a /files file to the chat", async () => {
  using w = world({ files: true })
  const space = memberSpace(owner)
  const pdf = new Uint8Array(Buffer.from("%PDF-1.4\n%\u00e2\u00e3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF", "latin1"))
  await w.memberFiles.write(space, "Downloads/statement.pdf", pdf, { writer: { kind: "browser", url: "https://bank.example.test/statements/1" } })
  const session = w.store.createSession({ owner, memberFiles: true, files: true })
  const done = await w.turn(session.id, [read("/files/Downloads/statement.pdf"), { name: "save_file", input: { path: "/files/Downloads/statement.pdf" } }])
  assert.match(done.results[0]?.output ?? "", /downloaded in the browser from bank\.example\.test/)
  assert.equal(done.results[0]?.documents?.length, 1)
  assert.match(done.results[1]?.output ?? "", /Saved statement\.pdf to their Files/)
  assert.equal(w.store.listSavedFiles(session.id)[0]?.name, "statement.pdf")
})

test("owner routes: add, list with origins, download and delete, only ever for the owner named by the service", async () => {
  using w = world()
  const app = w.app(w.runnerWith(scripted([])))
  const call = (path: string, init: RequestInit = {}, as: string | null = owner) =>
    app.fetch(new Request(`http://runner${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(as ? { "x-openwork-headless-owner": as } : {}), ...(init.headers ?? {}) } }))
  const added = await call(`/v1/owner/files?path=${encodeURIComponent("Uploads/brief.txt")}`, { method: "PUT", body: "hello", headers: { "content-type": "text/plain" } })
  assert.equal(added.status, 201)
  const file = z.object({ id: z.string(), path: z.string(), origin: z.object({ kind: z.string() }) }).parse(await added.json())
  assert.equal(file.origin.kind, "upload")
  assert.equal((await call(`/v1/owner/files?path=${encodeURIComponent("Uploads/brief.txt")}`, { method: "PUT", body: "again" })).status, 409, "an upload never replaces a file silently")
  assert.equal((await call(`/v1/owner/files?path=${encodeURIComponent("../x")}`, { method: "PUT", body: "x" })).status, 400)
  const listed = z.object({ files: z.array(z.object({ id: z.string() })), usage: z.object({ bytes: z.number(), maxBytes: z.number() }) }).parse(await (await call("/v1/owner/files")).json())
  assert.deepEqual(listed.files.map((entry) => entry.id), [file.id])
  assert.equal(listed.usage.bytes, 5)
  const download = await call(`/v1/owner/files/${file.id}`)
  assert.equal(await download.text(), "hello")
  assert.equal(decodeURIComponent(download.headers.get("x-file-path") ?? ""), "Uploads/brief.txt")
  assert.equal(JSON.stringify(await (await call("/v1/owner/files")).json()).includes("members/"), false, "store keys never leave the runner")
  // Another member, or no owner at all: nothing.
  assert.equal((await call(`/v1/owner/files/${file.id}`, {}, "wb:member-b")).status, 404)
  assert.deepEqual(z.object({ files: z.array(z.unknown()) }).parse(await (await call("/v1/owner/files", {}, "wb:member-b")).json()).files, [])
  assert.equal((await call("/v1/owner/files", {}, null)).status, 400)
  assert.equal((await call(`/v1/owner/files/${file.id}`, { method: "DELETE" }, "wb:member-b")).status, 404)
  assert.equal((await call(`/v1/owner/files/${file.id}`, { method: "DELETE" })).status, 204)
  assert.equal(w.bucket.keys("members/").length, 0)
})

test("deleting a conversation keeps the member's files; a session can't have My files without an owner", async () => {
  using w = world()
  const app = w.app(w.runnerWith(scripted([])))
  const call = (path: string, init: RequestInit = {}) => app.fetch(new Request(`http://runner${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-openwork-headless-owner": owner } }))
  assert.equal((await call("/v1/sessions", { method: "POST", body: JSON.stringify({ memberFiles: true }) })).status, 400)
  const created = await call("/v1/sessions/hs_member_chat_1", { method: "PUT", body: JSON.stringify({ owner, memberFiles: true, agent: "workbot" }) })
  assert.equal(created.status, 201)
  assert.equal((await call("/v1/sessions/hs_member_chat_2", { method: "PUT", body: JSON.stringify({ owner, agent: "Not A Slug" }) })).status, 400)
  await w.turn("hs_member_chat_1", [write("/files/keep.md", "kept")])
  assert.equal((await call("/v1/sessions/hs_member_chat_1", { method: "DELETE" })).status, 204)
  const [file] = await w.memberFiles.list(memberSpace(owner))
  assert.equal(file?.path, "keep.md")
  assert.equal(Buffer.from((await w.memberFiles.read(memberSpace(owner), { path: "keep.md" }))?.bytes ?? []).toString(), "kept")
})

test("a chat in its own cell reads and writes its owner's files through the owner cell, and nobody else's", async () => {
  const bucket = memoryBlobs()
  const stores = new Map<string, { store: Store; host: SessionCells; index: ReturnType<typeof localMemberFileIndex> }>()
  const identity = (name: string): CellIdentity => (name.startsWith("owner:") ? { kind: "owner", owner: name.slice(6) } : { kind: "session", sessionId: name.slice(8) })
  const callFrom = (from: string): CellCall => async (to, path, body) => {
    const answer = await cellOf(to).host.handle(from, path, JSON.parse(JSON.stringify(body)))
    if (answer.status >= 400) throw new CellCallError(answer.status, z.object({ error: z.string() }).parse(answer.body).error)
    return JSON.parse(JSON.stringify(answer.body))
  }
  function cellOf(name: string) {
    const existing = stores.get(name)
    if (existing) return existing
    const store = new Store(nodeSqlite(":memory:"))
    const index = localMemberFileIndex(store.db, (fn) => store.transaction(fn))
    const host = new SessionCells({ store, cells: CellsStore.of(store), self: () => identity(name), call: callFrom(name), memberFiles: index, memberFileLimits: DEFAULT_MEMBER_FILE_LIMITS })
    const created = { store, host, index }
    stores.set(name, created)
    return created
  }
  const ownerCell = cellOf(ownerCellName(owner))
  const chatId = `hs_c_${"a".repeat(32)}`
  const chat = cellOf(sessionCellName(chatId))
  CellsStore.of(chat.store).claimCellOwner(owner)
  chat.store.putSession(chatId, { owner, memberFiles: true, agent: "workbot" })
  assert.equal(await chat.host.syncDirectory(), true)
  const files = new MemberFiles(chat.host.memberFileIndex(chat.index), bucket.store, DEFAULT_MEMBER_FILE_LIMITS)
  const runner = new Runner({ store: chat.store, model: scripted([write("/files/agents/workbot/plan.md", "from my own cell"), read("/files/agents/workbot/plan.md")]), defaultModel: "test-model", defaultModelApiKey: "k", limits, memberFiles: files })
  runner.send({ sessionId: chatId, messageId: "msg_1", prompt: "go", credentials: {} })
  await runner.idle()
  // The row is the owner cell's; the session cell's own table stays empty.
  const [row] = await ownerCell.index.list(memberSpace(owner))
  assert.equal(row?.path, "agents/workbot/plan.md")
  assert.equal(row?.lastWriter.sessionId, chatId)
  assert.deepEqual(await chat.index.list(memberSpace(owner)), [])
  assert.match(chat.store.turnMessages(chatId, "msg_1").map(({ message }) => (message.role === "assistant" ? message.text : "")).join(""), /from my own cell/)
  // Another owner's chat cell is refused; and nobody can point a row at another space's objects.
  const strangerId = `hs_c_${"b".repeat(32)}`
  const stranger = cellOf(sessionCellName(strangerId))
  CellsStore.of(stranger.store).claimCellOwner("wb:member-b")
  stranger.store.putSession(strangerId, { owner: "wb:member-b", memberFiles: true })
  await stranger.host.syncDirectory()
  assert.equal((await ownerCell.host.handle(sessionCellName(strangerId), "/internal/member-files", { op: "list" })).status, 404)
  const forged = await ownerCell.host.handle(sessionCellName(chatId), "/internal/member-files", {
    op: "commit",
    path: "x.md",
    size: 1,
    mediaType: "text/plain",
    storageKey: "members/0000000000000000000000000000000000000000/abc",
    writer: { kind: "agent" },
    limits: DEFAULT_MEMBER_FILE_LIMITS,
  })
  assert.equal(forged.status, 400)
  for (const entry of stores.values()) entry.store.close()
})

test("an upload waits for the person's approval of those files for that site, which only the caller can give", async () => {
  using w = world()
  let clock = 1_000_000
  const session = w.store.createSession({ owner, memberFiles: true })
  const approvals = uploadApprovalsFor(w.store.db, session.id, "msg_1", () => clock)
  const a = { path: "/files/Downloads/a.csv", version: 1 }
  const b = { path: "/files/Uploads/b.pdf", version: 1 }
  assert.deepEqual(await approvals.approvedHosts([a]), [])
  const id = await approvals.request([a], "expenses.example.test")
  assert.equal(await approvals.request([a], "expenses.example.test"), id, "the same ask isn't repeated")
  const app = w.app(w.runnerWith(scripted([])))
  const call = (path: string, init: RequestInit = {}) => app.fetch(new Request(`http://runner${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }))
  const pending = z.object({ approvals: z.array(z.object({ id: z.string(), paths: z.array(z.string()), host: z.string(), messageId: z.string().nullable() })) }).parse(await (await call(`/v1/sessions/${session.id}/upload-approvals`)).json())
  assert.deepEqual(pending.approvals, [{ id, paths: ["/files/Downloads/a.csv"], host: "expenses.example.test", messageId: "msg_1" }])
  assert.equal((await call(`/v1/sessions/${session.id}/upload-approvals/ua_unknown`, { method: "POST", body: JSON.stringify({ decision: "approve" }) })).status, 404)
  assert.equal((await call(`/v1/sessions/${session.id}/upload-approvals/${id}`, { method: "POST", body: JSON.stringify({ decision: "approve", host: "evil.example.test" }) })).status, 400)
  assert.equal((await call(`/v1/sessions/${session.id}/upload-approvals/${id}`, { method: "POST", body: JSON.stringify({ decision: "approve" }) })).status, 200)
  // Approved: for those files (or fewer of them) and that site only, for a while.
  clock = Date.now()
  const now = uploadApprovalsFor(w.store.db, session.id, "msg_2")
  assert.deepEqual(await now.approvedHosts([a]), ["expenses.example.test"])
  assert.deepEqual(await now.approvedHosts([a, b]), [])
  assert.deepEqual(await now.approvedHosts([{ ...a, version: 2 }]), [], "a file changed since it was approved needs a new approval")
  const later = uploadApprovalsFor(w.store.db, session.id, "msg_3", () => Date.now() + 16 * 60_000)
  assert.deepEqual(await later.approvedHosts([a]), [], "an approval runs out")
  // Declined asks aren't pending, and nothing was approved by them.
  const declined = await now.request([b], "expenses.example.test")
  assert.equal((await call(`/v1/sessions/${session.id}/upload-approvals/${declined}`, { method: "POST", body: JSON.stringify({ decision: "decline" }) })).status, 200)
  assert.deepEqual(await now.approvedHosts([b]), [])
  assert.deepEqual(pendingUploadApprovals(w.store.db, session.id), [])
})
