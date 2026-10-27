/**
 * Whose agent (`slackAgentIdentity`): in a shared Slack thread, "stop" or "change that" only steers your own agent.
 * Runs the real worker against a real database with a fake Slack; nothing reaches a runner.
 */
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, summary } from "./harness.js"

const den = await bootDen({
  env: {
    DEN_HEADLESS_RUNNER_URL: "http://127.0.0.1:9",
    DEN_HEADLESS_RUNNER_TOKEN: "headless-runner-test-token-not-for-production-0123456789",
    DEN_SLACK_ASSISTANT_WORKER_ENABLED: "false",
  },
})
after(() => den.close())

const { db } = await import("../../src/db.js")
const { eq } = await import("@openwork-ee/den-db/drizzle")
const { SlackAssistantEventTable: Event, SlackAssistantInstallationTable: Installation } = await import("@openwork-ee/den-db/schema")
const { processSlackEvent } = await import("../../src/slack-assistant/worker.js")
const { createLiveFeeds } = await import("../../src/slack-assistant/live.js")
type EventRow = import("../../src/slack-assistant/repository.js").EventRow

type SlackCall = { token: string; method: string; body: Record<string, unknown> }

let onConnection: DenTypeId<"externalMcpConnection">
let offConnection: DenTypeId<"externalMcpConnection">

async function install(organizationId: string, teamId: string) {
  const connectionId = createDenTypeId("externalMcpConnection")
  await db.insert(Installation).values({
    connectionId,
    organizationId: normalizeDenTypeId("organization", organizationId),
    enabled: true,
    signingSecret: "s".repeat(32),
    teamId,
    appId: "A0APP",
    botUserId: "U0BOT",
    botToken: "xoxb-test",
  })
  return connectionId
}

before(async () => {
  const created = await den.createOrg(await den.signUp("Member A"), "Whose agent org")
  const on = await den.setFeature(created.orgId, "slackAgentIdentity", true)
  assert.equal(on.status, 200, summary(on))
  onConnection = await install(created.orgId, "T0ON")
  const other = await den.createOrg(await den.signUp("Member B"), "Feature off org")
  offConnection = await install(other.orgId, "T0OFF")
})

let sequence = 0
/** An event in the queue; `leased` events are held by this test, the rest by another worker. */
async function event(input: {
  connectionId: DenTypeId<"externalMcpConnection">
  user: string
  channel?: string
  threadTs?: string
  status?: string
  payload?: Record<string, unknown>
  checkpoint?: Record<string, unknown>
}) {
  sequence += 1
  const channel = input.channel ?? "C0SHARED"
  const threadTs = input.threadTs ?? "100.000"
  const row = {
    id: `ev_${sequence}`,
    connectionId: input.connectionId,
    teamId: input.connectionId === onConnection ? "T0ON" : "T0OFF",
    slackUserId: input.user,
    channelId: channel,
    threadTs,
    payload: JSON.stringify(input.payload ?? { type: "app_mention", user: input.user, channel, thread_ts: threadTs, ts: `${100 + sequence}.000`, text: "<@U0BOT> summarize this" }),
    checkpoint: input.checkpoint ? JSON.stringify(input.checkpoint) : null,
    status: input.status ?? "pending",
    leaseOwner: `lease_${sequence}`,
    leaseUntil: new Date(Date.now() + 60_000),
    createdAt: new Date(Date.now() - 1_000 + sequence),
  }
  await db.insert(Event).values(row)
  return stored(row.id)
}

const mention = (user: string, text: string, channel = "C0SHARED", threadTs = "100.000") => ({
  type: "app_mention",
  user,
  channel,
  thread_ts: threadTs,
  ts: `${200 + sequence}.000`,
  text: `<@U0BOT> ${text}`,
})

async function run(row: EventRow) {
  const calls: SlackCall[] = []
  const runnerCalls: string[] = []
  await processSlackEvent(row, {
    slack: (token) => async (method, body) => {
      calls.push({ token, method, body })
      return { ok: true, ts: "300.000" }
    },
    runner: () => {
      const refuse = async () => {
        runnerCalls.push("runner")
        throw new Error("no runner in this test")
      }
      return { create: refuse, send: refuse, read: refuse, stop: refuse, background: refuse, turnText: refuse }
    },
    live: createLiveFeeds({ open: async () => null }),
  })
  assert.deepEqual(runnerCalls, [], "steering never reaches a runner")
  return calls
}

async function stored(id: string) {
  const [row] = await db.select().from(Event).where(eq(Event.id, id))
  if (!row) throw new Error(`event ${id} missing`)
  return row
}

/** Member B's agent is answering in the shared thread. */
const memberBAnswering = (connectionId = onConnection) =>
  event({
    connectionId,
    user: "U067890",
    status: "running",
    checkpoint: { phase: "read", channel: "C0SHARED", threadTs: "100.000", privateReply: false, ownerLine: true, recipientUserId: "U067890", workbot: true },
  })

test("another person's 'stop' gets a private note naming the owner, and the owner's agent keeps working", async () => {
  const busy = await memberBAnswering()
  const stop = await event({ connectionId: onConnection, user: "U012345", payload: mention("U012345", "stop working on this") })
  const calls = await run(stop)
  assert.deepEqual(calls, [
    {
      token: "xoxb-test",
      method: "chat.postEphemeral",
      body: {
        channel: "C0SHARED",
        user: "U012345",
        thread_ts: "100.000",
        text: "That's <@U067890>'s agent, so only <@U067890> can stop it. You can ask your own agent anytime: mention <@U0BOT> with what you need.",
      },
    },
  ])
  assert.equal((await stored(stop.id)).status, "done")
  assert.equal((await stored(stop.id)).checkpoint, null, "never admitted, so it doesn't count toward the daily limit")
  const untouched = await stored(busy.id)
  assert.equal(untouched.cancelled, false)
  assert.equal(untouched.status, "running")
  await db.delete(Event).where(eq(Event.id, busy.id))
})

test("another person's 'change that' gets the same kind of note", async () => {
  const busy = await memberBAnswering()
  const change = await event({ connectionId: onConnection, user: "U012345", payload: mention("U012345", "change that") })
  const calls = await run(change)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.body.text, "That's <@U067890>'s agent, so only <@U067890> can change what it's doing. You can ask your own agent: mention <@U0BOT> with the whole request.")
  assert.equal((await stored(busy.id)).cancelled, false)
  await db.delete(Event).where(eq(Event.id, busy.id))
})

test("pressing Slack's Stop on another person's agent says whose it is instead of doing nothing", async () => {
  const busy = await memberBAnswering()
  const pressed = await event({
    connectionId: onConnection,
    user: "U012345",
    payload: { type: "agent_session_stopped", user: "U012345", channel: "C0SHARED", thread_ts: "100.000" },
  })
  const calls = await run(pressed)
  assert.deepEqual(calls.map((call) => [call.method, call.body.user, call.body.text]), [
    ["chat.postEphemeral", "U012345", "That's <@U067890>'s agent, so only <@U067890> can stop it. You can ask your own agent anytime: mention <@U0BOT> with what you need."],
  ])
  assert.equal((await stored(busy.id)).cancelled, false)
  await db.delete(Event).where(eq(Event.id, busy.id))
})

test("the owner's own 'stop' ends their running task, as Slack's Stop button would", async () => {
  const busy = await memberBAnswering()
  const stop = await event({ connectionId: onConnection, user: "U067890", payload: mention("U067890", "stop") })
  const calls = await run(stop)
  assert.deepEqual(calls, [], "the stopped reply says Stopped. itself")
  assert.equal((await stored(busy.id)).cancelled, true)
  assert.equal((await stored(stop.id)).status, "done")
  await db.delete(Event).where(eq(Event.id, busy.id))
})

test("a real request, or a thread where the busy agent replies privately, runs as the sender's own agent", async () => {
  const busy = await memberBAnswering()
  // Not steering: it goes on to the sender's own agent (here, unlinked: the connect card).
  const request = await event({ connectionId: onConnection, user: "U012345", payload: mention("U012345", "stop the deploy") })
  const requestCalls = await run(request)
  assert.deepEqual(requestCalls.map((call) => call.method), ["chat.postEphemeral"])
  assert.match(String(requestCalls[0]?.body.text), /Connect once/)
  assert.equal((await stored(request.id)).status, "awaiting_link")
  await db.delete(Event).where(eq(Event.id, busy.id))

  // A private reply is never named, so nobody learns who asked.
  await event({
    connectionId: onConnection,
    user: "U067890",
    status: "running",
    channel: "C0OTHER",
    threadTs: "500.000",
    checkpoint: { phase: "read", channel: "D067890", threadTs: "501.000", privateReply: true, recipientUserId: "U067890" },
  })
  const stop = await event({ connectionId: onConnection, user: "U012345", channel: "C0OTHER", threadTs: "500.000", payload: mention("U012345", "stop", "C0OTHER", "500.000") })
  const stopCalls = await run(stop)
  assert.ok(stopCalls.every((call) => !String(call.body.text).includes("U067890")))
  assert.equal((await stored(stop.id)).status, "awaiting_link")
})

test("with the feature off, steering messages run as before", async () => {
  const busy = await memberBAnswering(offConnection)
  const stop = await event({ connectionId: offConnection, user: "U012345", payload: mention("U012345", "stop working on this") })
  const calls = await run(stop)
  assert.ok(calls.every((call) => !String(call.body.text).includes("agent, so only")))
  assert.equal((await stored(stop.id)).status, "awaiting_link")
  assert.equal((await stored(busy.id)).cancelled, false)
})
