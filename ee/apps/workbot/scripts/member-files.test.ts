/**
 * My files in Workbot (docs/features/member-files): chats ask the runner for them only with Den's `memberFiles`, the
 * routes exist only then, every call names the signed-in person's owner, uploads never replace a file, and an answer
 * shows the files its chat wrote.
 */
import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import { Hono } from "hono"
import { createHeadlessRunnerClient } from "@openwork-ee/headless-protocol"
import { createWorkbot, freeMemberPath, resetWorkbotSessionCells, workbotOwner, type WorkbotActor } from "@openwork-ee/workbot-server"
import { createAuth, type AppEnv } from "../src/server/auth.js"
import { createDen, denSessionSchema } from "../src/server/den.js"
import { loadConfig } from "../src/server/config.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"

const actor: WorkbotActor = { organizationId: "org_files", organizationName: "Example", organizationMetadata: null, memberId: "member_files", userId: "user_files", firstName: "Alex" }
const owner = workbotOwner(actor.organizationId, actor.memberId)
const PUBLIC = "http://localhost:3090"
type Call = { method: string; path: string; search: string; body: unknown; owner: string | null }

const memberFile = (path: string, extra: Record<string, unknown> = {}) => ({
  id: `mf_${path.length.toString(16).padStart(32, "0")}`,
  path,
  name: path.split("/").pop(),
  mediaType: "text/plain",
  size: 5,
  version: 1,
  origin: { kind: "agent", agent: "workbot", url: null },
  lastWriter: { kind: "agent", sessionId: null, messageId: null },
  createdAt: 10,
  updatedAt: 10,
  ...extra,
})

/** A runner with sessions and My files, recording every call (and whose owner it named). */
function fakeRunner(state: { files: Array<ReturnType<typeof memberFile>>; memberFiles: boolean }) {
  const calls: Call[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
    const method = init?.method ?? "GET"
    let body: unknown = null
    if (typeof init?.body === "string") body = JSON.parse(init.body)
    calls.push({ method, path: url.pathname, search: url.search, body, owner: new Headers(init?.headers).get("x-openwork-headless-owner") })
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
    if (url.pathname === "/v1/files/status") return json(200, { enabled: true, memberFiles: state.memberFiles })
    if (url.pathname === "/v1/sessions" && method === "GET") return json(200, { sessions: [] })
    if (url.pathname.startsWith("/v1/sessions/") && method === "PUT") return json(201, { id: decodeURIComponent(url.pathname.split("/")[3] ?? "") })
    if (url.pathname.endsWith("/upload-approvals") && method === "GET") return json(200, { approvals: [{ id: `ua_${"2".repeat(32)}`, paths: ["/files/Downloads/a.csv"], host: "expenses.example.test", messageId: "wb_m", createdAt: 1 }] })
    if (url.pathname.includes("/upload-approvals/") && method === "POST") return json(200, { ok: true, decision: "approve" })
    if (url.pathname.endsWith("/saved-files") && method === "GET") return json(200, { files: [] })
    if (url.pathname.startsWith("/v1/sessions/") && method === "GET") {
      return json(200, {
        turns: [{ messageId: "wb_message_0001", status: "completed", error: null, createdAt: 100, updatedAt: 200 }],
        messages: [
          { role: "user", messageId: "wb_message_0001", text: "Download my statement" },
          { role: "assistant", messageId: "wb_message_0001", text: "Saved it to [statement.csv](/files/Downloads/statement.csv).", toolCalls: [] },
        ],
        finalAssistantText: "",
      })
    }
    if (url.pathname === "/v1/owner/files" && method === "GET") {
      const session = url.searchParams.get("session")
      const prefix = url.searchParams.get("prefix")
      const files = state.files.filter((file) => (!session || file.lastWriter.sessionId === session) && (!prefix || file.path.startsWith(`${prefix}/`)))
      return json(200, { files, usage: { bytes: files.length * 5, files: files.length, maxBytes: 10 * 1024 ** 3, maxFileBytes: 100 * 1024 ** 2 } })
    }
    if (url.pathname === "/v1/owner/files" && method === "PUT") {
      const created = memberFile(url.searchParams.get("path") ?? "", { origin: { kind: "upload", agent: null, url: null } })
      state.files.push(created)
      return json(201, created)
    }
    return json(404, { error: "not_found" })
  }
  return { calls, fetch }
}

function workbotWith(runner: ReturnType<typeof fakeRunner>, memberFiles: boolean) {
  const client = createHeadlessRunnerClient({ config: { url: "http://runner.test", token: "x".repeat(32), owner }, fetch: runner.fetch, mintToken: async () => ({ token: "turn-token" }), maxTokenTtlMs: 3_600_000 })
  return createWorkbot({ client, canSchedule: async () => false, sessionCells: true, memberFiles })
}

beforeEach(() => resetWorkbotSessionCells())

test("chats ask for My files as the workbot agent only while Den has it on, and say so when it goes off", async () => {
  for (const on of [true, false]) {
    resetWorkbotSessionCells()
    const runner = fakeRunner({ files: [], memberFiles: true })
    await workbotWith(runner, on).ensureComputer(actor)
    const put = runner.calls.find((call) => call.method === "PUT")
    assert.ok(put && typeof put.body === "object" && put.body !== null)
    assert.equal("memberFiles" in put.body ? put.body.memberFiles : undefined, on)
    assert.equal("agent" in put.body ? put.body.agent : undefined, on ? "workbot" : undefined)
  }
})

test("listing and adding name the person's owner, and an added file never replaces one with its name", async () => {
  const runner = fakeRunner({ files: [memberFile("Uploads/brief.txt")], memberFiles: true })
  const workbot = workbotWith(runner, true)
  const listed = await workbot.listMemberFiles(actor)
  assert.equal(listed.enabled, true)
  assert.deepEqual(listed.files.map((file) => file.path), ["Uploads/brief.txt"])
  const added = await workbot.uploadMemberFile(actor, { name: "brief.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("again").buffer })
  assert.ok(added.ok)
  assert.equal(added.file.path, "Uploads/brief (2).txt")
  for (const call of runner.calls.filter((entry) => entry.path.startsWith("/v1/owner/"))) assert.equal(call.owner, owner)
  assert.equal(freeMemberPath("Uploads", "a/b\u0000.txt", new Set()), "Uploads/a b .txt")
  // Off in Den, or not kept by this runner: nothing to list, and no owner call.
  const off = fakeRunner({ files: [memberFile("x.txt")], memberFiles: true })
  assert.deepEqual(await workbotWith(off, false).listMemberFiles(actor), { enabled: false, files: [], usage: null })
  assert.equal(off.calls.some((call) => call.path === "/v1/owner/files"), false)
  assert.equal((await workbotWith(fakeRunner({ files: [], memberFiles: false }), true).listMemberFiles(actor)).enabled, false)
})

test("an answer shows the files its chat wrote to My files, and not the person's other files", async () => {
  const sessionId = await workbotWith(fakeRunner({ files: [], memberFiles: true }), true).sessionIdOf(actor)
  const ours = memberFile("Downloads/statement.csv", { origin: { kind: "browser", agent: null, url: "https://bank.example.test/s" }, lastWriter: { kind: "browser", sessionId, messageId: "wb_message_0001" }, createdAt: 150, updatedAt: 150 })
  const theirs = memberFile("Uploads/other.txt", { lastWriter: { kind: "upload", sessionId: null, messageId: null }, createdAt: 150, updatedAt: 150 })
  const state = { files: [ours, theirs], memberFiles: true }
  const thread = await workbotWith(fakeRunner(state), true).readThread(actor)
  assert.deepEqual(thread.turns[0]?.outputs.map((file) => file.name), ["statement.csv"])
})

async function route(session: Record<string, unknown>, path: string, init: RequestInit = {}) {
  const config = loadConfig({ WORKBOT_PUBLIC_URL: PUBLIC, WORKBOT_DEN_API_URL: "http://localhost:3091", WORKBOT_RUNNER_URL: "http://localhost:3092", WORKBOT_RUNNER_TOKEN: "r".repeat(32), WORKBOT_SESSION_SECRET: "s".repeat(32) })
  const den = createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl })
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, { config, den, sameOrigin: createAuth({ config, den }).sameOrigin, member: async (c, next) => {
    const who = denSessionSchema.parse({ user: { id: "user_example", name: "Example", email: "member@example.test" }, organization: { id: "org_example", name: "Example workspace", brandAppName: null }, memberId: "member_example", canSchedule: false, ...session })
    c.set("member", { session: { id: "session_example", userId: who.user.id, organizationId: who.organization.id, tokens: { accessToken: "fixture-token", expiresAt: Date.now() + 60000 }, createdAt: Date.now() }, accessToken: "fixture-token", den: who })
    await next()
  } })
  return app.request(`${PUBLIC}${path}`, { ...init, headers: { origin: PUBLIC, ...(init.headers ?? {}) } })
}

test("with the feature off the page sees no My files, its routes don't exist and My files ids are unknown", async () => {
  const me = async (session: Record<string, unknown>) => {
    const body: unknown = await (await route(session, "/v1/workbot/me")).json()
    return typeof body === "object" && body !== null && "memberFiles" in body ? body.memberFiles : null
  }
  assert.equal(await me({ enabled: true }), false, "a Den from before the feature: off")
  assert.equal(await me({ enabled: false, memberFiles: true }), false, "never while Workbot is off")
  assert.equal(await me({ enabled: true, memberFiles: true }), true)
  const id = `mf_${"0".repeat(32)}`
  assert.equal((await route({ enabled: true }, "/v1/workbot/my-files")).status, 404)
  assert.equal((await route({ enabled: true }, "/v1/workbot/my-files?name=a.txt", { method: "POST", body: "a" })).status, 404)
  assert.equal((await route({ enabled: true }, `/v1/workbot/files/${id}`)).status, 404)
  assert.equal((await route({ enabled: true }, `/v1/workbot/files/${id}`, { method: "DELETE" })).status, 404)
})

test("uploads the agent asked for are listed and answered only for the person's own chat, and only with My files on", async () => {
  const runner = fakeRunner({ files: [], memberFiles: true })
  const workbot = workbotWith(runner, true)
  const sessionId = await workbot.sessionIdOf(actor)
  const listed = await workbot.listUploadApprovals(actor)
  assert.deepEqual(listed.map((approval) => [approval.paths, approval.host]), [[["/files/Downloads/a.csv"], "expenses.example.test"]])
  assert.equal(await workbot.decideUploadApproval(actor, `ua_${"2".repeat(32)}`, "approve"), true)
  const calls = runner.calls.filter((call) => call.path.includes("/upload-approvals"))
  assert.deepEqual(calls.map((call) => [call.method, call.path]), [["GET", `/v1/sessions/${sessionId}/upload-approvals`], ["POST", `/v1/sessions/${sessionId}/upload-approvals/ua_${"2".repeat(32)}`]])
  assert.deepEqual(calls[1]?.body, { decision: "approve" })
  const off = fakeRunner({ files: [], memberFiles: true })
  assert.deepEqual(await workbotWith(off, false).listUploadApprovals(actor), [])
  assert.equal(await workbotWith(off, false).decideUploadApproval(actor, `ua_${"2".repeat(32)}`, "approve"), false)
  assert.equal(off.calls.some((call) => call.path.includes("/upload-approvals")), false)
  assert.deepEqual(await (await route({ enabled: true }, "/v1/workbot/uploads")).json(), { approvals: [] }, "off: nothing asks")
  assert.equal((await route({ enabled: true }, `/v1/workbot/uploads/ua_${"2".repeat(32)}`, { method: "POST", body: JSON.stringify({ decision: "approve" }), headers: { "content-type": "application/json" } })).status, 404)
})
