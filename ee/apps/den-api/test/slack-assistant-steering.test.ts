import assert from "node:assert/strict"
import { test } from "node:test"
import { SlackApiError } from "../src/slack-assistant/protocol.js"
import { advanceSlackRun, checkpointSchema, CHECK_IN_EVERY_MS, DONE_PING_AFTER_MS, STREAM_ROTATE_AFTER_MS, type Checkpoint } from "../src/slack-assistant/run.js"
import { agentLabelChunk, decideSteering, notYourAgentText, steeringCommand, type ThreadTask } from "../src/slack-assistant/steering.js"
import { fakeClock, fakeRunner, fakeSlack, idle, runToEnd, snapshot } from "./slack-fakes.js"

// --- Whose agent: the owner line -------------------------------------------------------------------------------------

test("the owner line is a context block mentioning the owner, which Slack shows as their name", () => {
  assert.deepEqual(agentLabelChunk("U012345"), {
    type: "blocks",
    blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: "<@U012345>'s agent" }] }],
  })
})

const sharedCp = (input: Partial<Checkpoint> = {}) =>
  checkpointSchema.parse({ phase: "create", prompt: "{}", channel: "C1", threadTs: "1.0", live: false, workbot: true, recipientUserId: "U012345", ...input })

test("every message of a shared reply opens with the owner line above its first words", async () => {
  const clock = fakeClock()
  const { slack, calls, text } = fakeSlack()
  let reads = 0
  const { runner } = fakeRunner([], {
    read: async () => {
      reads += 1
      // A long answer: the first part, then (after Slack's stream lifetime) the rest in a new message.
      if (reads === 1) return { ok: true, snapshot: snapshot({ finalAssistantText: "First part.", assistantTexts: ["First part."] }) }
      clock.advance(STREAM_ROTATE_AFTER_MS)
      return { ok: true, snapshot: idle("First part. And the rest.") }
    },
  })
  await runToEnd({ checkpoint: sharedCp({ ownerLine: true, live: true, workbot: false }), runner, slack, now: clock.now })
  const starts = calls.filter((call) => call.method === "chat.startStream")
  assert.equal(starts.length, 2, "the reply continued in a second message")
  for (const start of starts) {
    assert.ok(Array.isArray(start.body.chunks))
    assert.deepEqual(start.body.chunks[0], agentLabelChunk("U012345"))
  }
  assert.equal(text(), "First part.OpenWork task · continued\n\n And the rest.", "the owner line adds no text to the answer")
})

test("a reply without the owner line (feature off, private reply, older task) starts with its answer", async () => {
  for (const cp of [sharedCp(), sharedCp({ ownerLine: true, recipientUserId: "not-an-id" })]) {
    const { slack, calls } = fakeSlack()
    await runToEnd({ checkpoint: cp, runner: fakeRunner([idle("Here you go.")]).runner, slack })
    assert.deepEqual(calls.find((call) => call.method === "chat.startStream")?.body.chunks, [{ type: "markdown_text", text: "Here you go." }])
  }
})

test("when Slack refuses the owner line, the answer still goes out without it", async () => {
  const { slack: base, calls } = fakeSlack()
  let refused = 0
  const slack = async (method: string, body: Record<string, unknown>) => {
    if (method === "chat.startStream" && Array.isArray(body.chunks) && JSON.stringify(body.chunks).includes('"blocks"')) {
      refused += 1
      calls.push({ method, body })
      throw new SlackApiError("invalid_chunks")
    }
    return base(method, body)
  }
  const { result } = await runToEnd({ checkpoint: sharedCp({ ownerLine: true }), runner: fakeRunner([idle("Here you go.")]).runner, slack })
  assert.equal(refused, 1)
  assert.equal(result.done, true)
  assert.deepEqual(calls.filter((call) => call.method === "chat.startStream").at(-1)?.body.chunks, [{ type: "markdown_text", text: "Here you go." }])
})

test("a long quiet task whose answer opened with the owner line gets no second 'Done' ping", async () => {
  const clock = fakeClock()
  for (const ownerLine of [true, false]) {
    const { slack, calls } = fakeSlack()
    const cp = sharedCp({ phase: "read", sessionId: "hs_1", quiet: true, ownerLine, startedAt: clock.now() - DONE_PING_AFTER_MS * 10, lastCheckInAt: clock.now() })
    await runToEnd({ checkpoint: cp, runner: fakeRunner([idle("All three are done.")]).runner, slack, now: clock.now })
    const pings = calls.filter((call) => call.method === "chat.postMessage" && String(call.body.text).includes("Done:"))
    assert.equal(pings.length, ownerLine ? 0 : 1, `ownerLine ${ownerLine}`)
  }
})

test("a quiet task's hourly check-in stays as it was", async () => {
  const clock = fakeClock()
  const { slack, calls } = fakeSlack()
  const cp = sharedCp({ phase: "read", sessionId: "hs_1", quiet: true, ownerLine: true, startedAt: clock.now(), lastCheckInAt: clock.now() })
  clock.advance(CHECK_IN_EVERY_MS)
  await advanceSlackRun({ checkpoint: cp, runner: fakeRunner([snapshot()]).runner, slack, messageId: "msg_1", title: "t", saveSession: async () => {}, clearSession: async () => {}, now: clock.now })
  assert.equal(calls.find((call) => call.method === "chat.postMessage")?.body.text, "Still working on it (1h 0m so far).")
})

// --- Whose agent: steering -------------------------------------------------------------------------------------------

test("only messages that steer running work count as steering, not requests that happen to start with stop", () => {
  for (const text of [
    "<@B1> stop",
    "<@B1> stop working on this",
    "<@B1> Stop it!",
    "<@B1> please stop",
    "<@B1> can you stop what you’re doing?",
    "<@B1> cancel that",
    "<@B1> never mind",
    "<@B1> nevermind, thanks",
    "<@B1> ok forget it",
    "<@B1> --private stop now",
  ])
    assert.equal(steeringCommand(text), "stop", text)
  for (const text of ["<@B1> change that", "<@B1> redo it please", "<@B1> try again", "<@B1> do it differently"])
    assert.equal(steeringCommand(text), "change", text)
  for (const text of [
    "<@B1> stop the deploy",
    "<@B1> cancel my 3pm meeting",
    "<@B1> change that to Friday",
    "<@B1> what's on my calendar?",
    "<@B1> wait",
    "<@B1> stopwatch for 5 minutes",
    "",
  ])
    assert.equal(steeringCommand(text), null, text)
})

const memberBBusy: ThreadTask = { id: "ev_member_b", slackUserId: "U067890", shared: true }

test("someone else's busy agent: stop and change get a polite note naming its owner, and no task runs", () => {
  const stop = decideSteering({ command: "stop", sender: "U012345", directMessage: false, tasks: [memberBBusy], botUserId: "U0BOT" })
  assert.deepEqual(stop, {
    action: "not_yours",
    text: "That's <@U067890>'s agent, so only <@U067890> can stop it. You can ask your own agent anytime: mention <@U0BOT> with what you need.",
  })
  const change = decideSteering({ command: "change", sender: "U012345", directMessage: false, tasks: [memberBBusy], botUserId: "U0BOT" })
  assert.deepEqual(change, {
    action: "not_yours",
    text: "That's <@U067890>'s agent, so only <@U067890> can change what it's doing. You can ask your own agent: mention <@U0BOT> with the whole request.",
  })
})

test("your own running agent: stop ends it, and change waits its turn like any follow-up", () => {
  const own: ThreadTask = { id: "ev_member_a", slackUserId: "U012345", shared: true }
  assert.deepEqual(decideSteering({ command: "stop", sender: "U012345", directMessage: false, tasks: [memberBBusy, own] }), { action: "stop_own", eventIds: ["ev_member_a"] })
  assert.deepEqual(decideSteering({ command: "change", sender: "U012345", directMessage: false, tasks: [memberBBusy, own] }), { action: "run" })
  // In your own DM nobody else's agent is ever named.
  assert.deepEqual(decideSteering({ command: "stop", sender: "U012345", directMessage: true, tasks: [] }), { action: "run" })
})

test("a request that isn't steering, a private reply, or an idle thread runs as your own agent", () => {
  assert.deepEqual(decideSteering({ command: null, sender: "U012345", directMessage: false, tasks: [memberBBusy] }), { action: "run" })
  assert.deepEqual(decideSteering({ command: "stop", sender: "U012345", directMessage: false, tasks: [{ ...memberBBusy, shared: false }] }), { action: "run" })
  assert.deepEqual(decideSteering({ command: "stop", sender: "U012345", directMessage: false, tasks: [] }), { action: "run" })
})

test("the note never builds a mention from anything but a Slack user id", () => {
  assert.equal(
    notYourAgentText({ slackUserId: "<!here>" }, "stop"),
    "That's another person's agent, so only they can stop it. You can ask your own agent anytime: mention me with what you need.",
  )
  assert.equal(
    notYourAgentText({ slackUserId: "not-an-id" }, "change", "<!channel>"),
    "That's another person's agent, so only they can change what it's doing. You can ask your own agent: mention me with the whole request.",
  )
})
