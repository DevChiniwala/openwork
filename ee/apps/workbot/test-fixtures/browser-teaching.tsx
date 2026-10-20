import { useState } from "react"
import { createRoot } from "react-dom/client"
import { WorkbotTeaching } from "../../../packages/workbot-ui/src/teaching"
import { setWorkbotHost } from "../../../packages/workbot-ui/src/host"
import "../src/client/styles.css"

const requestJson = async (path: string, init?: RequestInit) => {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } })
  return { response, payload: await response.json() }
}
setWorkbotHost({ requestJson, async prepare(path) { return { url: path, headers: new Headers(), credentials: "same-origin" } }, user: { name: "Member" }, useConnectedApps: () => [], appIcons: () => [], homeHref: "/", browserDemonstrations: true })
function Fixture() {
  const [teachingId, setTeachingId] = useState<string>()
  const [text, setText] = useState("")
  const [status, setStatus] = useState("")
  return <main className="workbot mx-auto flex min-h-screen max-w-5xl flex-col gap-4 bg-[var(--wb-bg)] p-6 text-[var(--wb-text)]">
    <h1 className="text-lg font-medium">Teach a browser lookup</h1>
    <WorkbotTeaching onTakeControl={() => setStatus("You have browser control")} onTeachingChange={setTeachingId} onRun={async text => {
      const sent = await requestJson("/v1/workbot/messages", { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(), text }) })
      if (!sent.response.ok) { setStatus("The run was refused"); return }
      const result = await requestJson("/fixture/result")
      setStatus(JSON.stringify(result.payload))
    }} />
    <form className="flex flex-col gap-2" onSubmit={async event => {
      event.preventDefault()
      const sent = await requestJson("/v1/workbot/messages", { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(), text, teachingId }) })
      setStatus(sent.response.ok ? "Explanation added to the conversation" : "The explanation was refused")
    }}>
      <label>Explain this step<textarea className="w-full rounded-lg border border-[var(--wb-hairline)] bg-[var(--wb-surface)] p-3" value={text} onChange={event => setText(event.target.value)} /></label>
      <button type="submit">Send explanation</button>
    </form>
    <output className="whitespace-pre-wrap" role="status">{status}</output>
  </main>
}
const root = document.getElementById("root")
if (root) createRoot(root).render(<Fixture />)
