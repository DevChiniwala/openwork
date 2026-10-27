/**
 * My files across surfaces, end to end: the browser downloads a file in one chat, the next turn of another chat reads it
 * with read_file, and that chat's browser uploads it to a website.
 *
 * Real: the runner's HTTP API, turns, file tools, My files store (disk), the computer's browser handling (Computers:
 * desktop setup, downloads collection, upload copies, the desktop bridge protocol), the cloud browser's own task code
 * (`@openwork/computer-use/chromium`: open, observe, act with upload) and a headless Chrome. Stand-ins: the model is
 * scripted, and each conversation's computer is a folder on this machine (its /files and /workspace mapped into it) with
 * a small bridge that hands browser tasks to the cloud browser. Chrome saves downloads into that computer's
 * /files/Downloads, as the desktop's Chromium does through its ~/Downloads link.
 *
 *   pnpm --filter @openwork-ee/headless-runner member-files:e2e
 *
 * Needs Chrome (CHROME_PATH, or Google Chrome / Chromium installed) and python3. Without Chrome it is skipped, unless
 * MEMBER_FILES_E2E_REQUIRE_CHROME=1.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { z } from "zod"
import { Computers } from "@openwork-ee/headless-computer"
import { createCloudBrowser } from "@openwork/computer-use/chromium"
import { createFakeProvider } from "@openwork/sandbox/testing"
import type { RunSpec, SandboxHandle } from "@openwork/sandbox"
import { createApp } from "../src/app.js"
import { diskBlobStore } from "../src/blobs.js"
import { DEFAULT_MEMBER_FILE_LIMITS, localMemberFileIndex, MemberFiles } from "../src/member-files.js"
import type { ModelClient, ModelRequest } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import { mediaTypeFor } from "../src/saved-files.js"
import { Store } from "../src/store.js"
import { readToolFile } from "../src/tool-files.js"
import type { Message } from "../src/types.js"

const token = "e2e-token-0123456789-0123456789-0123456789"
const owner = "wb:e2e-member"
const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }
const limits = { maxConcurrentTurns: 4, maxSteps: 12, turnTimeoutMs: Number.POSITIVE_INFINITY, credentialRefreshMs: Number.POSITIVE_INFINITY, contextCharBudget: 200_000 }
const STATEMENT = "date,description,amount\n2026-10-01,Coffee beans,18.50\n2026-10-03,Train ticket,23.50\n"

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]
  return candidates.find((candidate): candidate is string => typeof candidate === "string" && existsSync(candidate)) ?? null
}

// ---------------------------------------------------------------------------------------------------- Chrome

const cdpMessage = z.object({ id: z.number().optional(), method: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(), result: z.record(z.string(), z.unknown()).optional(), error: z.object({ message: z.string() }).optional() })

/** Headless Chrome, and its browser-level DevTools connection (downloads only; the cloud browser drives the tabs). */
async function launchChrome(binary: string, profile: string) {
  // CI's Ubuntu restricts the user namespaces Chrome's sandbox needs; nothing untrusted loads in this check.
  const sandbox = process.env.CI ? ["--no-sandbox"] : []
  const child = spawn(binary, ["--headless=new", ...sandbox, "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore" })
  const portFile = join(profile, "DevToolsActivePort")
  for (let attempt = 0; attempt < 100 && !existsSync(portFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100))
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n")
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("Chrome's DevTools socket didn't open")), { once: true })
  })
  let next = 0
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
  const downloads = new Map<string, string>()
  socket.addEventListener("message", (event) => {
    const parsed = cdpMessage.safeParse(JSON.parse(String(event.data)))
    if (!parsed.success) return
    const message = parsed.data
    if (message.id !== undefined) {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) waiter?.reject(new Error(message.error.message))
      else waiter?.resolve(message.result ?? {})
      return
    }
    const progress = z.object({ guid: z.string(), state: z.string().optional() }).safeParse(message.params)
    if (message.method === "Browser.downloadWillBegin" && progress.success) downloads.set(progress.data.guid, "inProgress")
    if (message.method === "Browser.downloadProgress" && progress.success && progress.data.state) downloads.set(progress.data.guid, progress.data.state)
  })
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      next += 1
      pending.set(next, { resolve, reject })
      socket.send(JSON.stringify({ id: next, method, params }))
    })
  return {
    endpoint: `http://127.0.0.1:${port}`,
    /** Where downloads go: on the desktop, ~/Downloads (linked to /files/Downloads by the bridge). */
    downloadInto: (folder: string) => send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: folder, eventsEnabled: true }),
    /** Waits for downloads started so far, so the check doesn't depend on timing (the next browser call would collect them). */
    async settleDownloads() {
      for (let attempt = 0; attempt < 100 && [...downloads.values()].includes("inProgress"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50))
      return [...downloads.values()]
    },
    close: () => {
      socket.close()
      child.kill()
    },
  }
}

// ---------------------------------------------------------------------------------------------------- computers as folders

/**
 * A provider whose computers are folders here: commands run in bash with /files and /workspace mapped into the folder,
 * and the desktop bridge is a small script speaking its protocol (stdin JSON, stdout JSON), handing browser tasks to
 * `control`, which runs them in the cloud browser.
 */
function folderComputers(root: string, control: string) {
  const provider = createFakeProvider({ capabilities: { platform: { os: "linux", isolation: "microvm" } } })
  const shims = join(root, "bin")
  mkdirSync(shims, { recursive: true })
  writeFileSync(join(shims, "sudo"), '#!/bin/sh\n[ "$1" = "-n" ] && shift\nexec "$@"\n')
  writeFileSync(
    join(shims, "openwork-desktop-bridge"),
    `#!/usr/bin/env python3
import json, os, sys, urllib.request
base = os.environ['OW_BASE']
op = sys.argv[1]
if op == 'command':
    command = json.load(sys.stdin)['command']
    os.chdir(os.path.join(base, 'workspace'))
    os.execvp('bash', ['bash', '-c', command])
if op == 'start':
    open(os.path.join(base, '.desktop-version'), 'w').write(sys.argv[2])
    print(json.dumps({'ok': True, 'version': sys.argv[2]}))
elif op == 'files':
    os.makedirs(os.path.join(base, 'files', 'Downloads'), exist_ok=True)
    print(json.dumps({'ok': True, 'files': sys.argv[2]}))
elif op == 'call' and sys.argv[2] == '/health':
    path = os.path.join(base, '.desktop-version')
    print(json.dumps({'version': open(path).read()} if os.path.exists(path) else {}))
else:
    body = json.loads(sys.stdin.read() or '{}')
    request = urllib.request.Request('${control}' + sys.argv[2], data=json.dumps({'base': base, 'body': body}).encode(), headers={'content-type': 'application/json'})
    print(urllib.request.urlopen(request, timeout=120).read().decode())
`,
  )
  chmodSync(join(shims, "sudo"), 0o755)
  chmodSync(join(shims, "openwork-desktop-bridge"), 0o755)
  const baseOf = (handle: SandboxHandle) => {
    const base = join(root, handle.ref.ref.sandboxId ?? "missing")
    mkdirSync(join(base, "workspace", ".jobs"), { recursive: true })
    return base
  }
  // Only a path that starts with /files or /workspace (not one inside another path) is the computer's.
  const map = (base: string, text: string) =>
    text
      .replaceAll("/usr/local/sbin/openwork-desktop-bridge", join(shims, "openwork-desktop-bridge"))
      .replace(/(?<![\w.~/-])\/(files|workspace)(?![\w.-])/g, (_, folder: string) => join(base, folder))
  const pathOf = (handle: SandboxHandle, path: string) => {
    if (!/^\/(files|workspace)(\/|$)/.test(path)) throw new Error(`outside the computer: ${path}`)
    return join(baseOf(handle), path)
  }
  const run = (handle: SandboxHandle, spec: RunSpec) =>
    new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
      const base = baseOf(handle)
      const env = Object.fromEntries(Object.entries(spec.env ?? {}).map(([key, value]) => [key, map(base, value)]))
      const child = spawn("bash", ["-c", map(base, spec.command)], { env: { ...process.env, ...env, PATH: `${shims}:${process.env.PATH ?? ""}`, OW_BASE: base }, cwd: base })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
      const timer = setTimeout(() => child.kill(), spec.timeoutMs)
      child.on("error", reject)
      child.on("close", (code) => {
        clearTimeout(timer)
        resolve({ exitCode: code ?? 1, stdout, stderr })
      })
    })
  const files = {
    read: async (handle: SandboxHandle, path: string) => new Uint8Array(readFileSync(pathOf(handle, path))),
    write: async (handle: SandboxHandle, path: string, bytes: Uint8Array) => {
      const full = pathOf(handle, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, bytes)
    },
    stat: async (handle: SandboxHandle, path: string) => {
      const full = pathOf(handle, path)
      if (!existsSync(full)) return null
      return { size: readFileSync(full).byteLength, kind: "file" as const }
    },
  }
  return { ...provider, blocks: { run, files, pause: async () => undefined } }
}

// ---------------------------------------------------------------------------------------------------- the model

type Planned = { name: string; input: Record<string, unknown> }
type Step = Planned | ((results: string[]) => Planned)
const promptOf = (request: ModelRequest) => request.messages.filter((message): message is Extract<Message, { role: "user" }> => message.role === "user").at(-1)?.text.split("\n").at(-1) ?? ""
const resultsOf = (request: ModelRequest) => {
  const index = request.messages.findLastIndex((message) => message.role === "user")
  return request.messages.slice(index + 1).flatMap((message) => (message.role === "tool" ? [message.output] : []))
}

/** Each prompt is a fixed plan of tool calls (later ones may read earlier results); the answer quotes the last result. */
function plannedModel(plans: Record<string, Step[]>): ModelClient {
  return {
    async complete(request) {
      const results = resultsOf(request)
      const next = (plans[promptOf(request)] ?? [])[results.length]
      if (next) return { text: "", toolCalls: [{ id: `call_${results.length}`, ...(typeof next === "function" ? next(results) : next) }], usage }
      return { text: `Done. ${results.at(-1)?.split("\n")[0] ?? ""}`, toolCalls: [], usage }
    },
  }
}

/** The browser's JSON answer at the start of a desktop result (notes about My files follow it). */
const browserAnswer = z.object({ tabId: z.string().optional(), observationId: z.string().optional(), elements: z.array(z.object({ ref: z.string(), name: z.string().optional() })).optional() }).loose()
const answerOf = (output: string | undefined) => browserAnswer.parse(JSON.parse((output ?? "{}").split("\n")[0] ?? "{}"))
const refNamed = (output: string | undefined, name: string) => {
  const ref = answerOf(output).elements?.find((element) => element.name === name)?.ref
  if (!ref) throw new Error(`no control named ${name}`)
  return ref
}
const tabsOf = (output: string | undefined) => z.object({ tabs: z.array(z.object({ tabId: z.string() })) }).loose().parse(JSON.parse((output ?? "{}").split("\n")[0] ?? "{}")).tabs.map((tab) => tab.tabId)
const desktop = (operation: string, args: Record<string, unknown>) => ({ name: "desktop", input: { view: "browser", operation, args, description: "Working in the browser" } })

// ---------------------------------------------------------------------------------------------------- the journey

const chrome = chromePath()
const skip = !chrome && process.env.MEMBER_FILES_E2E_REQUIRE_CHROME !== "1" ? "Chrome isn't installed (set CHROME_PATH)" : false

test("a file the browser downloads in one chat is read by another chat's next turn and uploaded by its browser", { skip, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "member-files-e2e-"))
  const cleanup: Array<() => void | Promise<void>> = [() => rmSync(root, { recursive: true, force: true })]
  try {
    // A bank with a statement to download, and an expenses site that takes one.
    const received: string[] = []
    const site: Server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/expenses") {
        let body = ""
        request.on("data", (chunk: Buffer) => (body += chunk.toString()))
        request.on("end", () => {
          received.push(body)
          response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Thanks</title><p>Statement received.</p>")
        })
        return
      }
      if (request.url === "/statement.csv") {
        response.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="october-statement.csv"' }).end(STATEMENT)
        return
      }
      const page = request.url === "/expenses"
        ? '<!doctype html><title>Expenses</title><form method="post" action="/expenses" enctype="multipart/form-data"><label>Statement <input type="file" name="statement"></label><button>Send</button></form>'
        : '<!doctype html><title>Bank</title><a href="/statement.csv">Download statement</a>'
      response.writeHead(200, { "content-type": "text/html" }).end(page)
    })
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve))
    cleanup.push(() => new Promise<void>((resolve) => site.close(() => resolve())))
    const siteAddress = site.address()
    assert.ok(siteAddress && typeof siteAddress === "object")
    const siteUrl = `http://127.0.0.1:${siteAddress.port}`

    // Chrome, and one cloud browser per computer (as each desktop runs its own), its Downloads in that computer's /files.
    assert.ok(chrome, "Chrome is required")
    const browser = await launchChrome(chrome, join(root, "chrome-profile"))
    cleanup.push(() => browser.close())
    const browsers = new Map<string, ReturnType<typeof createCloudBrowser>>()
    const control: Server = createServer((request, response) => {
      let raw = ""
      request.on("data", (chunk: Buffer) => (raw += chunk.toString()))
      request.on("end", () => {
        void (async () => {
          const call = z.object({ base: z.string(), body: z.record(z.string(), z.unknown()) }).parse(JSON.parse(raw))
          if (request.url !== "/browser/task") return response.end("{}")
          let cloud = browsers.get(call.base)
          if (!cloud) {
            cloud = createCloudBrowser({ statePath: join(call.base, "browser-tabs.json"), endpoint: browser.endpoint, privateBrowsing: true, enabled: () => true, assertActive() {}, beforeInput: async () => {}, verifyEgress: async () => {}, uploadRoot: join(call.base, "files") })
            browsers.set(call.base, cloud)
          }
          await browser.downloadInto(join(call.base, "files", "Downloads"))
          const result = await cloud.request(call.body, { signal: new AbortController().signal })
          await browser.settleDownloads()
          response.end(JSON.stringify(result))
        })().catch((error: unknown) => response.writeHead(500).end(String(error)))
      })
    })
    await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve))
    cleanup.push(() => new Promise<void>((resolve) => control.close(() => resolve())))
    cleanup.push(() => { for (const cloud of browsers.values()) cloud.close() })
    const controlAddress = control.address()
    assert.ok(controlAddress && typeof controlAddress === "object")

    // The runner: its store, My files on disk, a computer with the desktop per conversation, a scripted model.
    const store = new Store(nodeSqlite(join(root, "runner.sqlite")))
    cleanup.push(() => store.close())
    const memberFiles = new MemberFiles(localMemberFileIndex(store.db, (fn) => store.transaction(fn)), diskBlobStore(join(root, "store")), DEFAULT_MEMBER_FILE_LIMITS)
    const computer = new Computers({ provider: folderComputers(join(root, "computers"), `http://127.0.0.1:${controlAddress.port}`), idlePauseMs: 60_000, keepDays: 1, desktop: true }, {
      readFile: (file, counts) => readToolFile({ name: file.name, mimeType: mediaTypeFor(file.name), data: Buffer.from(file.bytes).toString("base64") }, counts),
    })
    const model = plannedModel({
      "Download my October statement": [
        desktop("open", { url: `${siteUrl}/bank` }),
        (results) => desktop("observe", { tabId: answerOf(results[0]).tabId, mode: "interactive" }),
        (results) => desktop("act", { tabId: answerOf(results[1]).tabId, observationId: answerOf(results[1]).observationId, actions: [{ type: "click", ref: refNamed(results[1], "Download statement") }] }),
      ],
      "Send my October statement to the expenses site": [
        { name: "read_file", input: { path: "/files/Downloads/october-statement.csv" } },
        desktop("open", { url: `${siteUrl}/expenses` }),
        (results) => desktop("observe", { tabId: answerOf(results[1]).tabId, mode: "interactive" }),
        (results) => desktop("act", {
          tabId: answerOf(results[2]).tabId,
          observationId: answerOf(results[2]).observationId,
          actions: [{ type: "upload", ref: refNamed(results[2], "Statement"), paths: ["/files/Downloads/october-statement.csv"] }, { type: "click", ref: refNamed(results[2], "Send") }],
        }),
      ],
      "Approved: upload october-statement.csv to the expenses site": [
        desktop("tabs", {}),
        (results) => desktop("navigate", { tabId: tabsOf(results[0])[0], url: `${siteUrl}/expenses` }),
        (results) => desktop("observe", { tabId: tabsOf(results[0])[0], mode: "interactive" }),
        (results) => desktop("act", {
          tabId: answerOf(results[2]).tabId,
          observationId: answerOf(results[2]).observationId,
          actions: [{ type: "upload", ref: refNamed(results[2], "Statement"), paths: ["/files/Downloads/october-statement.csv"] }, { type: "click", ref: refNamed(results[2], "Send") }],
        }),
      ],
      "Send a file that isn't there": [desktop("tabs", {}), (results) => desktop("act", { tabId: tabsOf(results[0])[0], observationId: "none", actions: [{ type: "upload", ref: "e1", paths: ["/files/Downloads/missing.pdf"] }] })],
    })
    const runner = new Runner({ store, model, defaultModel: "test-model", defaultModelApiKey: "test-key", limits, computer, memberFiles })
    const app = createApp({ store, runner, apiToken: token, computer, memberFiles })
    const call = (path: string, init: RequestInit = {}, as = owner) =>
      app.fetch(new Request(`http://runner${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-openwork-headless-owner": as } }))
    const turn = async (sessionId: string, messageId: string, prompt: string) => {
      const sent = await call(`/v1/sessions/${sessionId}/turns`, { method: "POST", body: JSON.stringify({ messageId, prompt }) })
      assert.equal(sent.status, 202)
      await runner.idle()
      const read = z.object({ turns: z.array(z.object({ messageId: z.string(), status: z.string() })), messages: z.array(z.object({ role: z.string(), output: z.string().optional() }).loose()) }).parse(await (await call(`/v1/sessions/${sessionId}?messageId=${messageId}`)).json())
      assert.equal(read.turns.find((entry) => entry.messageId === messageId)?.status, "completed")
      return read.messages.filter((message) => message.role === "tool").map((message) => message.output ?? "")
    }
    const chat = (id: string) => call(`/v1/sessions/${id}`, { method: "PUT", body: JSON.stringify({ owner, memberFiles: true, agent: "workbot", computer: true, desktop: true }) })
    assert.equal((await chat("hs_e2e_chat_bank")).status, 201)
    assert.equal((await chat("hs_e2e_chat_expenses")).status, 201)
    const listed = async (as = owner) => z.object({ files: z.array(z.object({ id: z.string(), path: z.string(), origin: z.object({ kind: z.string() }), lastWriter: z.object({ sessionId: z.string().nullable() }) })) }).parse(await (await call("/v1/owner/files", {}, as)).json()).files

    // 1. In the first chat, the browser downloads the statement: it is saved to My files, attributed to the browser.
    const download = await turn("hs_e2e_chat_bank", "msg_download", "Download my October statement")
    assert.match(download.at(-1) ?? "", /\[Saved to My files: \/files\/Downloads\/october-statement\.csv\]/)
    assert.deepEqual((await listed()).map((file) => [file.path, file.origin.kind, file.lastWriter.sessionId]), [["Downloads/october-statement.csv", "browser", "hs_e2e_chat_bank"]])
    console.log(`✓ browser download saved to My files: ${download.at(-1)?.split("\n").at(-1)}`)

    // 2. Another chat's next turn reads it with read_file; its browser may upload it only once the person approves.
    const expenses = await turn("hs_e2e_chat_expenses", "msg_expenses", "Send my October statement to the expenses site")
    assert.equal(expenses[0], STATEMENT, "read_file returns the downloaded statement")
    assert.match(expenses[3] ?? "", /They haven't approved uploading \/files\/Downloads\/october-statement\.csv to 127\.0\.0\.1:\d+\. .*Nothing was sent\./)
    assert.equal(received.length, 0, "nothing reaches the site before the person approves")
    const asked = z.object({ approvals: z.array(z.object({ id: z.string(), paths: z.array(z.string()), host: z.string() })) }).parse(await (await call("/v1/sessions/hs_e2e_chat_expenses/upload-approvals")).json()).approvals
    assert.deepEqual(asked.map((approval) => [approval.paths, approval.host]), [[["/files/Downloads/october-statement.csv"], `127.0.0.1:${siteAddress.port}`]])
    assert.equal((await call(`/v1/sessions/hs_e2e_chat_expenses/upload-approvals/${asked[0]?.id}`, { method: "POST", body: JSON.stringify({ decision: "approve" }) })).status, 200)
    const approved = await turn("hs_e2e_chat_expenses", "msg_approved", "Approved: upload october-statement.csv to the expenses site")
    assert.match(approved[3] ?? "", /"type":"upload","ref":"e1","outcome":"attached","files":1/)
    assert.equal(received.length, 1)
    assert.ok(received[0]?.includes('filename="october-statement.csv"') && received[0].includes("2026-10-01,Coffee beans,18.50"), "the site received the file from My files")
    console.log(`✓ another chat read ${expenses[0]?.split("\n").length} lines; its upload waited for approval, then the browser uploaded october-statement.csv (${received[0]?.length} bytes posted)`)

    // 3. A file that isn't in My files is refused before the browser does anything.
    const missing = await turn("hs_e2e_chat_expenses", "msg_missing", "Send a file that isn't there")
    assert.match(missing[1] ?? "", /There is no file at \/files\/Downloads\/missing\.pdf\. List \/files to find it\. Nothing was sent\./)
    assert.equal(received.length, 1)

    // 4. Deleting the first chat keeps the file; nobody else sees it.
    assert.equal((await call("/v1/sessions/hs_e2e_chat_bank", { method: "DELETE" })).status, 204)
    assert.deepEqual((await listed()).map((file) => file.path), ["Downloads/october-statement.csv"])
    assert.deepEqual(await listed("wb:someone-else"), [])
    console.log("✓ kept after the chat was deleted; another member sees 0 files; a missing file is refused before the browser acts")
  } finally {
    for (const step of cleanup.reverse()) await step()
  }
})
