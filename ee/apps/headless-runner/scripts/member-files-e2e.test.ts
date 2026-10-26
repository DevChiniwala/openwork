/**
 * My files across surfaces, end to end: a real headless Chrome downloads a file in one chat, the next turn of another
 * chat reads it with read_file, and that chat's computer opens it with bash and saves a result back.
 *
 * Real: the runner's HTTP API, turns, file tools, My files store (disk), the computer's sync (Computers, its scan and
 * path scripts, the desktop bridge protocol) and Chrome's download. Stand-ins: the model is scripted, and each
 * conversation's computer is a folder on this machine (its /files and /workspace mapped into it) with a small bridge that
 * hands browser tasks to Chrome, which saves downloads into that computer's /files/Downloads, as the desktop's Chromium
 * does through its ~/Downloads link.
 *
 *   pnpm --filter @openwork-ee/headless-runner member-files:e2e
 *
 * Needs Chrome (CHROME_PATH, or Google Chrome / Chromium installed) and python3. Without Chrome it is skipped, unless
 * MEMBER_FILES_E2E_REQUIRE_CHROME=1.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { z } from "zod"
import { Computers } from "@openwork-ee/headless-computer"
import { createFakeProvider } from "@openwork/sandbox/testing"
import type { RunSpec, SandboxHandle } from "@openwork/sandbox"
import { createApp } from "../src/app.js"
import { diskBlobStore } from "../src/blobs.js"
import { localMemberFileIndex, MemberFiles, DEFAULT_MEMBER_FILE_LIMITS } from "../src/member-files.js"
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
const limits = { maxConcurrentTurns: 4, maxSteps: 10, turnTimeoutMs: Number.POSITIVE_INFINITY, credentialRefreshMs: Number.POSITIVE_INFINITY, contextCharBudget: 200_000 }
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

// ---------------------------------------------------------------------------------------------------- Chrome over CDP

const cdpMessage = z.object({ id: z.number().optional(), method: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(), result: z.record(z.string(), z.unknown()).optional(), error: z.object({ message: z.string() }).optional(), sessionId: z.string().optional() })

async function launchChrome(binary: string, profile: string) {
  const child = spawn(binary, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore" })
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
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  socket.addEventListener("message", (event) => {
    const parsed = cdpMessage.safeParse(JSON.parse(String(event.data)))
    if (!parsed.success) return
    const message = parsed.data
    if (message.id !== undefined) {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) waiter?.reject(new Error(message.error.message))
      else waiter?.resolve(message.result ?? {})
    } else if (message.method) for (const listener of listeners) listener(message.method, message.params ?? {})
  })
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      next += 1
      pending.set(next, { resolve, reject })
      socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  return {
    send,
    on: (listener: (method: string, params: Record<string, unknown>) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => {
      socket.close()
      child.kill()
    },
  }
}
type Chrome = Awaited<ReturnType<typeof launchChrome>>

/** What the desktop guest does for a browser `open`: a tab goes to the address; a download lands in ~/Downloads. */
async function browserOpen(chrome: Chrome, url: string, downloads: string) {
  mkdirSync(downloads, { recursive: true })
  await chrome.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true })
  const target = z.object({ targetId: z.string() }).parse(await chrome.send("Target.createTarget", { url: "about:blank" }))
  const session = z.object({ sessionId: z.string() }).parse(await chrome.send("Target.attachToTarget", { targetId: target.targetId, flatten: true }))
  const finished = new Promise<{ state: string; guid: string }>((resolve) => {
    const stop = chrome.on((method, params) => {
      const progress = z.object({ guid: z.string(), state: z.string() }).safeParse(params)
      if (method === "Browser.downloadProgress" && progress.success && progress.data.state !== "inProgress") {
        stop()
        resolve(progress.data)
      }
    })
  })
  const started = new Promise<string>((resolve) => {
    const stop = chrome.on((method, params) => {
      const begin = z.object({ suggestedFilename: z.string() }).safeParse(params)
      if (method === "Browser.downloadWillBegin" && begin.success) {
        stop()
        resolve(begin.data.suggestedFilename)
      }
    })
  })
  await chrome.send("Page.navigate", { url }, session.sessionId)
  const [name, done] = await Promise.all([started, finished])
  await chrome.send("Target.closeTarget", { targetId: target.targetId })
  return { ok: done.state === "completed", downloaded: name, state: done.state }
}

// ---------------------------------------------------------------------------------------------------- computers as folders

/**
 * A provider whose computers are folders here: commands run in bash with /files and /workspace mapped into the folder,
 * and the desktop bridge is a small script speaking its protocol (stdin JSON, stdout JSON), handing browser tasks to
 * `control` (Chrome).
 */
function folderComputers(root: string, control: string) {
  const provider = createFakeProvider({ capabilities: { platform: { os: "linux", isolation: "microvm" } } })
  const shims = join(root, "bin")
  mkdirSync(shims, { recursive: true })
  writeFileSync(join(shims, "sudo"), '#!/bin/sh\n[ "$1" = "-n" ] && shift\nexec "$@"\n')
  writeFileSync(
    join(shims, "openwork-desktop-bridge"),
    `#!/usr/bin/env python3
import json, os, subprocess, sys, urllib.request
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

const promptOf = (request: ModelRequest) => request.messages.filter((message): message is Extract<Message, { role: "user" }> => message.role === "user").at(-1)?.text.split("\n").at(-1) ?? ""
const resultsOf = (request: ModelRequest) => {
  const index = request.messages.findLastIndex((message) => message.role === "user")
  return request.messages.slice(index + 1).filter((message): message is Extract<Message, { role: "tool" }> => message.role === "tool")
}

/** Each prompt is a fixed plan of tool calls; the answer quotes what the last one returned. */
function plannedModel(plans: Record<string, Array<{ name: string; input: Record<string, unknown> }>>, seen: ModelRequest[]): ModelClient {
  return {
    async complete(request) {
      seen.push(request)
      const plan = plans[promptOf(request)] ?? []
      const results = resultsOf(request)
      const next = plan[results.length]
      if (next) return { text: "", toolCalls: [{ id: `call_${results.length}`, ...next }], usage }
      return { text: `Done. ${results.at(-1)?.output.split("\n")[0] ?? ""}`, toolCalls: [], usage }
    },
  }
}

// ---------------------------------------------------------------------------------------------------- the journey

const chrome = chromePath()
const skip = !chrome && process.env.MEMBER_FILES_E2E_REQUIRE_CHROME !== "1" ? "Chrome isn't installed (set CHROME_PATH)" : false

test("a file the browser downloads in one chat is read by the next turn of another chat and opened on its computer", { skip, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "member-files-e2e-"))
  const cleanup: Array<() => void | Promise<void>> = [() => rmSync(root, { recursive: true, force: true })]
  try {
    // A site with a statement to download.
    const site: Server = createServer((request, response) => {
      if (request.url === "/statement.csv") {
        response.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="october-statement.csv"' })
        response.end(STATEMENT)
      } else response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve))
    cleanup.push(() => new Promise<void>((resolve) => site.close(() => resolve())))
    const siteAddress = site.address()
    assert.ok(siteAddress && typeof siteAddress === "object")
    const statementUrl = `http://127.0.0.1:${siteAddress.port}/statement.csv`

    // Chrome, and the bridge's browser tasks handed to it.
    assert.ok(chrome, "Chrome is required")
    const browser = await launchChrome(chrome, join(root, "chrome-profile"))
    cleanup.push(() => browser.close())
    const browserTasks: Array<{ operation: string; downloaded: string }> = []
    const control: Server = createServer((request, response) => {
      let raw = ""
      request.on("data", (chunk: Buffer) => (raw += chunk.toString()))
      request.on("end", () => {
        void (async () => {
          const body = z.object({ base: z.string(), body: z.object({ operation: z.string().optional(), args: z.record(z.string(), z.unknown()).optional() }).loose() }).parse(JSON.parse(raw))
          if (request.url !== "/browser/task") return response.end("{}")
          const url = z.object({ url: z.string() }).parse(body.body.args).url
          const opened = await browserOpen(browser, url, join(body.base, "files", "Downloads"))
          browserTasks.push({ operation: body.body.operation ?? "", downloaded: opened.downloaded })
          response.end(JSON.stringify({ ok: opened.ok, status: "ready", downloaded: opened.downloaded }))
        })()
      })
    })
    await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve))
    cleanup.push(() => new Promise<void>((resolve) => control.close(() => resolve())))
    const controlAddress = control.address()
    assert.ok(controlAddress && typeof controlAddress === "object")

    // The runner: its store, My files on disk, a computer per conversation (with the desktop), a scripted model.
    const store = new Store(nodeSqlite(join(root, "runner.sqlite")))
    cleanup.push(() => store.close())
    const blobs = diskBlobStore(join(root, "store"))
    const memberFiles = new MemberFiles(localMemberFileIndex(store.db, (fn) => store.transaction(fn)), blobs, DEFAULT_MEMBER_FILE_LIMITS)
    const computer = new Computers({ provider: folderComputers(join(root, "computers"), `http://127.0.0.1:${controlAddress.port}`), idlePauseMs: 60_000, keepDays: 1, desktop: true }, {
      readFile: (file, counts) => readToolFile({ name: file.name, mimeType: mediaTypeFor(file.name), data: Buffer.from(file.bytes).toString("base64") }, counts),
    })
    const seen: ModelRequest[] = []
    const model = plannedModel(
      {
        "Download my October statement": [{ name: "desktop", input: { view: "browser", operation: "open", args: { url: statementUrl }, description: "Downloading your statement" } }],
        "Add up my October statement": [
          { name: "read_file", input: { path: "/files/Downloads/october-statement.csv" } },
          {
            name: "bash",
            input: {
              description: "Adding up your statement",
              command: "cat /files/Downloads/october-statement.csv && mkdir -p /files/agents/workbot && python3 -c \"import csv;rows=list(csv.DictReader(open('/files/Downloads/october-statement.csv')));print('Total: %.2f' % sum(float(r['amount']) for r in rows))\" | tee /files/agents/workbot/october-total.txt",
            },
          },
        ],
      },
      seen,
    )
    const runner = new Runner({ store, model, defaultModel: "test-model", defaultModelApiKey: "test-key", limits, computer, memberFiles })
    const app = createApp({ store, runner, apiToken: token, computer, memberFiles })
    const call = (path: string, init: RequestInit = {}, as = owner) =>
      app.fetch(new Request(`http://runner${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-openwork-headless-owner": as } }))
    const turn = async (sessionId: string, messageId: string, prompt: string) => {
      const sent = await call(`/v1/sessions/${sessionId}/turns`, { method: "POST", body: JSON.stringify({ messageId, prompt }) })
      assert.equal(sent.status, 202)
      await runner.idle()
      const read = z.object({ turns: z.array(z.object({ messageId: z.string(), status: z.string() })), messages: z.array(z.object({ messageId: z.string(), role: z.string(), output: z.string().optional(), text: z.string().optional() }).loose()) }).parse(await (await call(`/v1/sessions/${sessionId}?messageId=${messageId}`)).json())
      assert.equal(read.turns.find((entry) => entry.messageId === messageId)?.status, "completed")
      return read.messages.filter((message) => message.role === "tool").map((message) => message.output ?? "")
    }
    const chat = (id: string) => call(`/v1/sessions/${id}`, { method: "PUT", body: JSON.stringify({ owner, memberFiles: true, agent: "workbot", computer: true, desktop: true }) })
    assert.equal((await chat("hs_e2e_chat_browser")).status, 201)
    assert.equal((await chat("hs_e2e_chat_numbers")).status, 201)
    const listed = async (as = owner) => z.object({ files: z.array(z.object({ id: z.string(), path: z.string(), size: z.number(), origin: z.object({ kind: z.string() }), lastWriter: z.object({ sessionId: z.string().nullable() }) })) }).parse(await (await call("/v1/owner/files", {}, as)).json()).files

    // 1. In the first chat, the browser downloads the statement: it lands in My files, attributed to the browser.
    const download = await turn("hs_e2e_chat_browser", "msg_download", "Download my October statement")
    assert.deepEqual(browserTasks, [{ operation: "open", downloaded: "october-statement.csv" }])
    assert.match(download[0] ?? "", /\[Saved to My files: \/files\/Downloads\/october-statement\.csv\]/)
    const afterDownload = await listed()
    assert.deepEqual(afterDownload.map((file) => [file.path, file.origin.kind, file.lastWriter.sessionId]), [["Downloads/october-statement.csv", "browser", "hs_e2e_chat_browser"]])
    console.log(`✓ browser download saved to My files: ${download[0]?.split("\n").at(-1)}`)

    // 2. Another chat's next turn reads it with read_file, and its own computer opens it and saves a total back.
    const numbers = await turn("hs_e2e_chat_numbers", "msg_numbers", "Add up my October statement")
    assert.equal(numbers[0], STATEMENT, "read_file returns the downloaded statement")
    assert.match(numbers[1] ?? "", /\[exit 0\]/)
    assert.ok((numbers[1] ?? "").includes("2026-10-01,Coffee beans,18.50"), "the second chat's computer has the file at the same path")
    assert.match(numbers[1] ?? "", /Total: 42\.00/)
    assert.match(numbers[1] ?? "", /\[Saved to My files: \/files\/agents\/workbot\/october-total\.txt\]/)
    console.log(`✓ headless turn read ${numbers[0]?.split("\n").length} lines; computer: ${(numbers[1] ?? "").split("\n").filter((line) => line.startsWith("Total") || line.startsWith("[Saved")).join(" ")}`)

    // 3. My files holds both, with where each came from; deleting the first chat keeps them; nobody else sees them.
    const files = await listed()
    assert.deepEqual(files.map((file) => [file.path, file.origin.kind]), [["Downloads/october-statement.csv", "browser"], ["agents/workbot/october-total.txt", "computer"]])
    const total = files.find((file) => file.path.endsWith("october-total.txt"))
    assert.ok(total)
    assert.equal((await (await call(`/v1/owner/files/${total.id}`)).text()).trim(), "Total: 42.00")
    assert.equal((await call("/v1/sessions/hs_e2e_chat_browser", { method: "DELETE" })).status, 204)
    assert.equal((await listed()).length, 2)
    assert.deepEqual(await listed("wb:someone-else"), [])
    // The first chat's computer was deleted with it; the second one's /files holds both.
    assert.equal(readFileSync(join(root, "computers", firstSandbox(root, "Total: 42.00"), "files", "agents", "workbot", "october-total.txt"), "utf8").trim(), "Total: 42.00")
    console.log(`✓ My files: ${files.map((file) => `/files/${file.path} (${file.origin.kind})`).join(", ")}; kept after the chat was deleted; another member sees 0 files`)
  } finally {
    for (const step of cleanup.reverse()) await step()
  }
})

/** The computer folder whose /files holds the total (the second chat's). */
function firstSandbox(root: string, content: string) {
  const computers = join(root, "computers")
  const found = readdirSync(computers).find((entry) => {
    const path = join(computers, entry, "files", "agents", "workbot", "october-total.txt")
    return existsSync(path) && readFileSync(path, "utf8").includes(content)
  })
  if (!found) throw new Error("no computer holds the total")
  return found
}
