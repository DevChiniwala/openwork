import { createRoot } from "react-dom/client"
import { ComputerPanel } from "../src/react-app/domains/session/computer/computer-panel"
import "../src/app/index.css"

// The isolated world serves the real broker and adapter behind this IPC boundary.
async function invoke(command: string, ...args: unknown[]) {
  const input = command === "computerPresentation" ? { visible: args[1] } : args[0]
  const route = command === "computerPresentation" ? "presentation" : command === "computerInteract" ? "decision" : "stop"
  const response = await fetch(`/fixture/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })
  if (!response.ok) throw new Error("Computer control was not confirmed")
  return response.json()
}
Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: invoke })
const output = document.createElement("output")
output.setAttribute("role", "status")
output.textContent = "Computer use enabled"
document.body.append(output)
const slot = document.createElement("main")
slot.style.cssText = "position:relative;width:min(800px,100vw);height:600px"
document.body.append(slot)
const root = document.createElement("div")
document.body.append(root)
createRoot(root).render(<ComputerPanel sessionId="fixture-chat" slot={slot} enabled canStop controlsBusy={false} stopping={false} cleanupPending={false} stopError="" onStop={() => { void invoke("computerHalt", { sessionId: "fixture-chat" }).then(() => { output.textContent = "Current work stopped" }) }} />)
