import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { shellQuote, type SandboxHandle, type SandboxProvider } from "@openwork/sandbox"
import { z } from "zod"

const BRIDGE = "/usr/local/sbin/openwork-desktop-bridge"
const viewerSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), paused: z.boolean() })
export type DesktopView = "browser" | "computer"

/** The existing conversation computer owns the desktop too; it never provisions a second machine. */
export class Desktop {
  private readonly starting = new Map<string, Promise<void>>()
  /** privateBrowsing lets the browser open loopback and private pages: operator diagnostics on a dedicated VM only. */
  constructor(private readonly provider: SandboxProvider, private readonly options: { privateBrowsing?: boolean } = {}) {}

  start(box: SandboxHandle): Promise<void> {
    const key = JSON.stringify(box.ref)
    let pending = this.starting.get(key)
    if (!pending) {
      pending = this.prepare(box).finally(() => this.starting.delete(key))
      this.starting.set(key, pending)
    }
    return pending
  }

  private async prepare(box: SandboxHandle) {
    const { run } = this.provider.blocks ?? {}
    if (!run || this.provider.describe().platform?.os !== "linux") throw new Error("Desktop access needs a configured Linux computer.")
    const identity = await readFile(new URL("../dist/desktop-guest.version", import.meta.url))
    const privateBrowsing = this.options.privateBrowsing === true
    const version = createHash("sha256").update(identity).update(privateBrowsing ? "private-browsing" : "").digest("hex")
    const ready = await this.call(box, "/health", {}).catch(() => null)
    if (z.object({ version: z.literal(version) }).safeParse(ready).success) return
    const result = await run(box, {
      command: `sudo -n ${BRIDGE} start ${version}`,
      timeoutMs: 45_000,
    })
    if (result.exitCode !== 0) throw new Error("The computer needs a desktop snapshot built for this runner, including its restricted desktop helper.")
    for (let attempt = 0; attempt < 30; attempt++) {
      const probe = await this.call(box, "/health", {}).catch(() => null)
      if (probe) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error("The desktop didn't respond. Try reconnecting.")
  }

  async call(box: SandboxHandle, path: string, body: unknown): Promise<unknown> {
    const run = this.provider.blocks?.run
    if (!run) throw new Error("Desktop access is unavailable.")
    const seconds = path === "/health" ? 4 : path === "/stop" ? 10 : 125
    const result = await run(box, {
      command: `printf %s ${shellQuote(JSON.stringify(body))} | sudo -n ${BRIDGE} call ${shellQuote(path)}`,
      timeoutMs: (seconds + 5) * 1000,
    })
    if (result.exitCode !== 0) throw new Error("The desktop operation didn't finish. Check the view before retrying.")
    return JSON.parse(result.stdout)
  }

  async viewer(box: SandboxHandle, input: { view: DesktopView; control: boolean; origin: string }) {
    await this.start(box)
    const ticket = viewerSchema.parse(await this.call(box, "/viewer", input))
    const endpoint = await this.provider.endpoint(box, 6080, { ttlSeconds: 75 })
    const url = new URL(endpoint.url)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.pathname = `${url.pathname.replace(/\/$/, "")}/vnc/${ticket.token}`
    return { url: url.toString(), expiresAt: Date.now() + 60_000, paused: ticket.paused }
  }
}
