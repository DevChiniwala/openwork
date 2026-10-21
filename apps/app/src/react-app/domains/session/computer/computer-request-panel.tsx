import { useState } from "react"
import { Monitor } from "lucide-react"
import type { ComputerRequest } from "@openwork/types/desktop-ipc"

import { desktopBridge } from "@/app/lib/desktop"
import { Button } from "@/components/ui/button"
import { useComputerStore } from "./computer-store"

/** "com.apple.TextEdit" reads as "TextEdit"; the agent's own purpose says the rest. */
function appLabel(appId: string | undefined) {
  const name = appId?.split(".").filter(Boolean).at(-1)
  return name && name.length <= 48 ? name : "a Mac app"
}

/**
 * Shown above the composer while the agent waits for computer use. The tool
 * call carries on by itself once the person answers, so the agent never has
 * to ask them to go set it up and try again.
 */
const SCRIPT_APPS = { applescript: "AppleScript", jxa: "JavaScript for Automation", blender: "Blender" } as const

/**
 * The agent wants to run an app script. Nothing runs until the person approves this
 * exact code here; the broker checks the answer against this request.
 */
function ScriptRequest({ sessionId, request, script }: { sessionId: string; request: ComputerRequest; script: NonNullable<ComputerRequest["script"]> }) {
  const name = SCRIPT_APPS[script.app]
  const [busy, setBusy] = useState<"allow" | "always" | "dismiss" | null>(null)
  const [error, setError] = useState("")

  async function answer(next: "allow" | "always" | "dismiss") {
    if (busy) return
    setBusy(next)
    setError("")
    try {
      await desktopBridge.computerAnswerRequest({ sessionId, answer: next, id: request.id })
    } catch (cause) {
      setError(`That wasn't saved. ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="overflow-hidden border-b border-dls-border bg-transparent" data-testid="session-computer-request" data-reason="script">
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover text-dls-secondary">
            <Monitor size={16} strokeWidth={1.9} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium leading-5 text-dls-text">Run a {name} script?</div>
            <div className="mt-0.5 text-[12px] leading-5 text-dls-secondary">It runs on {request.computer} as you and can change your files and apps.</div>
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-dls-border bg-dls-hover p-2 font-mono text-[12px] leading-5 text-dls-text whitespace-pre-wrap break-words" data-testid="session-computer-script" aria-label={`${name} script`}>{script.code}</pre>
            {error ? <div role="alert" className="mt-1 text-[12px] leading-5 text-red-11">{error}</div> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} aria-busy={busy === "dismiss"} data-testid="session-computer-script-dismiss" onClick={() => void answer("dismiss")}>Don't run</Button>
          <Button type="button" variant="outline" size="sm" disabled={busy !== null} aria-busy={busy === "always"} data-testid="session-computer-script-always" onClick={() => void answer("always")}>Always run {name} in this chat</Button>
          <Button type="button" size="sm" disabled={busy !== null} aria-busy={busy === "allow"} data-testid="session-computer-script-run" onClick={() => void answer("allow")}>Run</Button>
        </div>
      </div>
    </div>
  )
}

export function ComputerRequestPanel({ sessionId, request }: { sessionId: string; request: ComputerRequest }) {
  if (request.reason === "script" && request.script) return <ScriptRequest sessionId={sessionId} request={request} script={request.script} />
  return <SetupRequest sessionId={sessionId} request={request} />
}

function SetupRequest({ sessionId, request }: { sessionId: string; request: ComputerRequest }) {
  const remote = request.placement === "remote"
  const openSetup = useComputerStore((state) => state.openSetup)
  const [busy, setBusy] = useState<"dismiss" | null>(null)
  const [error, setError] = useState("")

  async function answer(next: "dismiss") {
    if (busy) return
    setBusy(next)
    setError("")
    try {
      await desktopBridge.computerAnswerRequest({ sessionId, answer: next })
    } catch (cause) {
      setError(`That wasn't saved. ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="overflow-hidden border-b border-dls-border bg-transparent" data-testid="session-computer-request" data-reason={request.reason}>
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover text-dls-secondary">
            <Monitor size={16} strokeWidth={1.9} />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-medium leading-5 text-dls-text">Set up computer use</div>
            <div className="mt-0.5 text-[12px] leading-5 text-dls-secondary">
              {remote ? request.detail || `${request.computer} needs a desktop connection.` : <>Turn on the macOS permissions to continue working in {appLabel(request.appId)}.</>}
            </div>
            {request.purpose ? <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-dls-secondary">{request.purpose}</div> : null}
            {error ? <div role="alert" className="mt-1 text-[12px] leading-5 text-red-11">{error}</div> : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} aria-busy={busy === "dismiss"} data-testid="session-computer-request-dismiss" onClick={() => void answer("dismiss")}>
            Not now
          </Button>
          {!remote ? <Button type="button" size="sm" data-testid="session-computer-request-setup" onClick={() => openSetup(sessionId)}>Set up</Button> : null}
        </div>
      </div>
    </div>
  )
}
