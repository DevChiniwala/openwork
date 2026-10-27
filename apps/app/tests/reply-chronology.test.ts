import { afterEach, expect, setSystemTime, test } from "bun:test"
import type { DynamicToolUIPart, UIMessage } from "ai"
import type { TextPart } from "@opencode-ai/sdk/v2/client"
import { getRunStartedAt } from "../src/components/chat/utils"
import { messageNotice, workingTime } from "../src/lib/session-run"
import { trackToolCallDuration } from "../src/lib/tool-call-duration"
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store"
import { orderMessageParents } from "../src/react-app/domains/session/sync/message-merge"
import { textPartToUIPart } from "../src/react-app/domains/session/sync/usechat-adapter"

const WORKSPACE = "workspace"

function user(id: string, created: number): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text: id }], metadata: { opencode: { created } } }
}

function reply(id: string, created: number, options: { completed?: number; parentID?: string } = {}): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text: id }], metadata: { opencode: { created, ...options } } }
}

function helperNotice(id: string, timestamp: number): UIMessage {
  const part = textPartToUIPart({
    id: `${id}:part`, sessionID: "parent", messageID: id, type: "text", text: "The helper finished.", synthetic: true,
    metadata: { source: "subagent", childID: "helper", state: "completed", description: "Research", openworkNoticeTimestamp: timestamp },
  } as TextPart)
  if (!part) throw new Error("notice was not mapped")
  return { id, role: "assistant", parts: [part] }
}

afterEach(() => {
  setSystemTime()
  useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {}, waitingByWorkspaceId: {} })
})

test("a fast reply is shown after the prompt it answers", () => {
  const prompt = user("prompt", 2_000)
  const answer = reply("answer", 1_999, { parentID: "prompt" })
  expect(orderMessageParents([answer, prompt]).map((message) => message.id)).toEqual(["prompt", "answer"])
  const inOrder = [prompt, answer]
  expect(orderMessageParents(inOrder)).toBe(inOrder)
})

test("time spent waiting for the person is not working time", () => {
  expect(workingTime(1_000, 11_000)).toBe(10_000)
  expect(workingTime(1_000, 11_000, [{ start: 3_000, end: 5_000 }])).toBe(8_000)
  // Overlapping waits count once; an open wait runs until now; waits before the run are ignored.
  expect(workingTime(1_000, 11_000, [{ start: 0, end: 2_000 }, { start: 3_000, end: 6_000 }, { start: 5_000, end: 7_000 }, { start: 9_000 }])).toBe(3_000)
})

test("a helper's completion notice survives as a visible line and continues the run like a follow-up", () => {
  const notice = helperNotice("notice", 6_000)
  expect(messageNotice(notice)).toMatchObject({ source: "subagent", subjectId: "helper", outcome: "completed", description: "Research", timestamp: 6_000 })
  // The reply had finished, so the notice starts a new run.
  expect(getRunStartedAt([user("first", 1_000), reply("answer", 1_100, { completed: 3_000 }), notice, reply("summary", 6_100)])).toBe(6_000)
  // The reply was still being written, so the notice joins the run.
  expect(getRunStartedAt([user("first", 1_000), reply("answer", 1_100), notice])).toBe(1_000)
})

test("a tool from old history without native timing shows no duration", () => {
  const part = (openwork: Record<string, unknown>) => ({
    type: "dynamic-tool", toolName: "read", toolCallId: `call-${Object.keys(openwork).join("-")}`, state: "output-available",
    input: {}, output: "", callProviderMetadata: { openwork },
  }) as unknown as DynamicToolUIPart
  expect(trackToolCallDuration(part({ timingUnavailable: true }))).toBeNull()
  expect(trackToolCallDuration(part({ toolStartedAt: 1_000, toolCompletedAt: 3_500 }))).toBe("2.5s")
})

test("a pending permission or question pauses the run's working time", () => {
  const store = useSessionActivityStore.getState()
  setSystemTime(new Date(10_000))
  store.setRunStatus(WORKSPACE, "session", { type: "busy" })
  setSystemTime(new Date(12_000))
  store.setWaitingRequest(WORKSPACE, "session", "permission", "permission-1", true)
  setSystemTime(new Date(15_000))
  store.setWaitingRequest(WORKSPACE, "session", "permission", "permission-1", false)
  expect(useSessionActivityStore.getState().recordsByWorkspaceId[WORKSPACE]?.session?.waits).toEqual([{ start: 12_000, end: 15_000 }])
})

test("a run waits while the only helper it is waiting on asks the person", () => {
  const store = useSessionActivityStore.getState()
  const helperCall = (state: "input-available" | "output-available") => ({
    id: `parent-reply-${state}`, role: "assistant", parts: [{
      type: "dynamic-tool", toolName: "task", toolCallId: "task-1", state, input: { description: "Research", prompt: "Look it up" },
      ...(state === "output-available" ? { output: "done" } : {}), callProviderMetadata: { openwork: { childSessionId: "helper" } },
    }],
  }) as unknown as UIMessage
  setSystemTime(new Date(20_000))
  store.setRunStatus(WORKSPACE, "parent", { type: "busy" })
  store.setRunStatus(WORKSPACE, "helper", { type: "busy" })
  store.observeTranscript(WORKSPACE, "parent", [user("prompt", 19_000), helperCall("input-available")])
  setSystemTime(new Date(22_000))
  store.setWaitingRequest(WORKSPACE, "helper", "question", "question-1", true)
  setSystemTime(new Date(30_000))
  store.setWaitingRequest(WORKSPACE, "helper", "question", "question-1", false)
  expect(useSessionActivityStore.getState().recordsByWorkspaceId[WORKSPACE]?.parent?.waits).toEqual([{ start: 22_000, end: 30_000 }])
})
