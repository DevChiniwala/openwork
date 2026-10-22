import type { SessionComputer } from "./types.js"

/**
 * Two configured computers behind one: each conversation's calls go to the provider it started on
 * (Session.computerProvider), so turning Freestyle on for an organization never moves an existing computer.
 * Both share the same tools and prompt; only where the machine runs differs.
 */
export function routeComputers(
  defaultComputer: SessionComputer,
  freestyle: SessionComputer,
  providerOf: (sessionId: string) => "default" | "freestyle" | null,
): SessionComputer {
  const pick = (sessionId: string) => providerOf(sessionId) === "freestyle" ? freestyle : defaultComputer
  const desktop = <K extends "desktopRun" | "desktopViewer" | "browserDemonstration" | "desktopAction">(sessionId: string, name: K): NonNullable<SessionComputer[K]> => {
    const method = pick(sessionId)[name]
    if (!method) throw new Error("Desktop access is not configured for this conversation's computer.")
    return method
  }
  return {
    prompt: defaultComputer.prompt,
    tools: defaultComputer.tools,
    toolNames: defaultComputer.toolNames,
    image: `${defaultComputer.image}, freestyle: ${freestyle.image}`,
    desktopTools: defaultComputer.desktopTools ?? freestyle.desktopTools,
    desktopRun: (sessionId, input, signal) => desktop(sessionId, "desktopRun").call(pick(sessionId), sessionId, input, signal),
    desktopViewer: (sessionId, input) => desktop(sessionId, "desktopViewer").call(pick(sessionId), sessionId, input),
    browserDemonstration: (sessionId, command) => desktop(sessionId, "browserDemonstration").call(pick(sessionId), sessionId, command),
    desktopAction: (sessionId, action) => desktop(sessionId, "desktopAction").call(pick(sessionId), sessionId, action),
    run: (sessionId, name, input) => pick(sessionId).run(sessionId, name, input),
    known: (sessionId) => pick(sessionId).known(sessionId),
    prewarm: (sessionId) => pick(sessionId).prewarm(sessionId),
    release: (sessionId) => pick(sessionId).release(sessionId),
    delete: (sessionId) => pick(sessionId).delete(sessionId),
    previewSavedFile: (sessionId, fileId) => pick(sessionId).previewSavedFile(sessionId, fileId),
  }
}
