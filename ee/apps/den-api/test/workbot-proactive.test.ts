import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { agentLedgerKey, AGENT_WAKE_MARKER, parseAgentReply, parseAgentState } from "@openwork/automations/proactive"
import {
  DEFAULT_AGENT_TEMPLATE,
  DEFAULT_WORKBOT_PROACTIVE_SETTINGS,
  mergeAgentTemplate,
  mergeWorkbotProactiveSettings,
  readWorkbotProactiveSettings,
  withWorkbotProactiveSettings,
  type WorkbotProactiveSettings,
} from "@openwork/types/den/workbot-proactive"
import type { HeadlessRunnerDeps } from "../src/headless-runner/client.js"
import type { AgentDestinationBlock } from "@openwork/types/den/workbot-proactive"
import type { DeliveryDeps } from "../src/workbot-proactive/deliver.js"
import type { WorkbotDirectMessageDeps } from "../src/slack-assistant/direct-message.js"
import type { AgentInstanceRow, AgentSettle } from "../src/workbot-proactive/repository.js"
import type { AgentTurnResult } from "../src/workbot-proactive/turn.js"
import type { AgentWakeDeps } from "../src/workbot-proactive/wake.js"
import type { AgentCheckRecord } from "../src/workbot-proactive/checks.js"

// No database, runner, Google or Connect is contacted: every boundary is injected or faked below.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/workbot_proactive_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-workbot-proactive-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-workbot-proactive-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { wakeAgent } = await import("../src/workbot-proactive/wake.js")
const { runAgentTurn, agentSessionId } = await import("../src/workbot-proactive/turn.js")
const { deliverAgentMessage, destinationBlock } = await import("../src/workbot-proactive/deliver.js")
const { sendWorkbotDirectMessage } = await import("../src/slack-assistant/direct-message.js")
const { SlackApiError } = await import("../src/slack-assistant/protocol.js")
const { createHeadlessRunnerClient } = await import("../src/headless-runner/client.js")
const { renderAgentTemplate } = await import("../src/workbot-proactive/template.js")
const policy = await import("../src/workbot-proactive/policy.js")
const preferences = await import("../src/workbot-proactive/preferences.js")
const { checkHeadline, describeAgentCheck, memberAgentCheck } = await import("../src/workbot-proactive/checks.js")

const TZ = "America/New_York"
// Tuesday 2026-10-20, 13:45 in New York.
const NOW = Date.parse("2026-10-20T17:45:00Z")
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const userId = createDenTypeId("user")
const slackConnectionId = createDenTypeId("externalMcpConnection")
const settingsOn: WorkbotProactiveSettings = { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS, enabled: true }

type RawEvent = Record<string, unknown>
function meeting(overrides: RawEvent = {}): RawEvent {
  return {
    id: "evt1",
    status: "confirmed",
    summary: "Quarterly review",
    created: "2026-10-01T12:00:00Z",
    updated: "2026-10-01T12:00:00.000Z",
    start: { dateTime: "2026-10-21T14:00:00-04:00" },
    end: { dateTime: "2026-10-21T14:30:00-04:00" },
    organizer: { email: "lead@northwind.example", displayName: "Northwind lead" },
    attendees: [
      { email: "me@contoso.example", self: true, responseStatus: "accepted" },
      { email: "lead@northwind.example", displayName: "Northwind lead" },
    ],
    ...overrides,
  }
}

function agentRow(overrides: Partial<AgentInstanceRow> = {}): AgentInstanceRow {
  return {
    memberId,
    organizationId,
    templateVersionId: null,
    status: null,
    overrides: null,
    snoozedUntil: null,
    state: null,
    timeZone: null,
    nextWakeAt: new Date(NOW),
    failures: 0,
    leaseOwner: "lease-1",
    leaseUntil: new Date(NOW + 600_000),
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    preferences: null,
    ...overrides,
  }
}

const message = (text: string, items: { responsibility: string; ref: string }[]) => JSON.stringify({ message: text, items })

type HarnessState = {
  records: AgentCheckRecord[]
  checks: { day: string; counts: { responsibility: string; checks: number; quiet: number; sent: number }[] }[]
  destinations: string[]
  clock: number
  events: RawEvent[]
  row: AgentInstanceRow
  ledger: Map<string, string>
  delivered: string[]
  turns: { prompt: string; sessionId: string; instructions: string }[]
  calendarReads: number
  settles: AgentSettle[]
}

/** An in-memory agent, ledger and destination; `events`, `clock` and the reply change between runs. */
function harness(input: { settings?: Partial<WorkbotProactiveSettings>; row?: Partial<AgentInstanceRow>; replies?: (string | AgentTurnResult)[]; sentToday?: number; allowed?: boolean[]; blocked?: AgentDestinationBlock; library?: boolean; google?: "ok" | "needs_connection"; sendFails?: boolean }) {
  const state: HarnessState = { records: [], checks: [], destinations: [], clock: NOW, events: [meeting()], row: agentRow(input.row), ledger: new Map(), delivered: [], turns: [], calendarReads: 0, settles: [] }
  const replies = [...(input.replies ?? ["NO_REPLY"])]
  let allowedCalls = 0
  const deps: AgentWakeDeps = {
    now: () => state.clock,
    allowed: async () => input.allowed?.[allowedCalls++] ?? true,
    settings: async () => ({ ...settingsOn, ...input.settings }),
    template: async () => ({ ...DEFAULT_AGENT_TEMPLATE, versionId: null, version: 1 }),
    user: async () => userId,
    calendar: async () => {
      state.calendarReads += 1
      if (input.google === "needs_connection") return { kind: "needs_connection" }
      return { kind: "ok", json: { timeZone: TZ, items: state.events } }
    },
    recordChecks: async (call) => {
      state.checks.push({ day: call.day, counts: [...call.counts] })
    },
    model: async () => "openai/gpt-6-luna",
    turn: async (call) => {
      state.turns.push({ prompt: call.prompt, sessionId: call.sessionId, instructions: call.instructions })
      const reply = replies.shift() ?? "NO_REPLY"
      return typeof reply === "string" ? parseAgentReply(reply) : reply
    },
    sessionId: agentSessionId,
    messageId: (member, at) => `wa_${member}_${at}`,
    told: async (_member, items) => new Set(items.map(agentLedgerKey).filter((key) => state.ledger.has(key))),
    reserve: async (entry) => {
      const key = agentLedgerKey(entry.item)
      if (state.ledger.has(key)) return null
      state.ledger.set(key, entry.outcome ?? "pending")
      return key
    },
    finish: async (id, outcome) => {
      state.ledger.set(id, outcome)
    },
    sentSince: async () => (input.sentToday ?? 0) + [...state.ledger.values()].filter((outcome) => outcome === "sent").length,
    holdsLease: async () => true,
    settle: async (_row, changes) => {
      state.settles.push(changes)
      state.row = { ...state.row, ...changes, leaseOwner: "lease-1" }
      return true
    },
    destinationBlock: async () => input.blocked ?? null,
    deliver: async (call) => {
      if (input.sendFails) return { ok: false, code: "send_failed" }
      state.delivered.push(call.text)
      state.destinations.push("workbot_dm")
      return { ok: true, message: { channelId: "D0DM", messageTs: "1700000000.0001", permalink: "https://example.slack.com/archives/D0DM/p17000000000001" } }
    },
    library: async () => input.library ?? false,
    recordCheck: async (record) => {
      const index = state.records.findIndex((entry) => entry.key === record.key)
      if (index >= 0) state.records[index] = record
      else state.records.push(record)
    },
  }
  return { state, deps, run: () => wakeAgent(state.row, deps) }
}

describe("waking a member's agent", () => {
  test("with no events at all, the scheduled pass still runs, in the agent's own session; NO_REPLY sends nothing", async () => {
    const h = harness({})
    const outcome = await h.run()
    assert.deepEqual(outcome, { status: "ran", reasons: ["scheduled"], reply: "quiet", delivered: null })
    assert.equal(h.state.turns.length, 1)
    assert.equal(h.state.turns[0]?.sessionId, agentSessionId(organizationId, memberId))
    assert.match(h.state.turns[0]?.sessionId ?? "", /^hs_agent_[a-f0-9]{40}$/)
    assert.ok(h.state.turns[0]?.prompt.startsWith(`${AGENT_WAKE_MARKER} Scheduled check: the morning pass.`), "the first pass of the day is the morning pass")
    assert.match(h.state.turns[0]?.prompt ?? "", /Gmail: never/)
    assert.deepEqual(h.state.delivered, [])
    const saved = parseAgentState(h.state.row.state)
    assert.equal(saved.lastPassAt, NOW)
    assert.equal(saved.nextPassAt, NOW + 3 * 3_600_000, "the next check is in about three hours")
    assert.equal(saved.lastLook.gmail, NOW)
    assert.equal(h.state.row.nextWakeAt.getTime(), NOW + 5 * 60_000, "the calendar is looked at again in five minutes")
  })

  test("a message is delivered once; the same item is never delivered again", async () => {
    const reply = message("Northwind is waiting on the renewal proposal (since 9:10 AM).", [{ responsibility: "waiting_on_you", ref: "thread-abc" }])
    const h = harness({ replies: [reply, reply] })
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "sent" })
    assert.deepEqual(h.state.delivered, ["Northwind is waiting on the renewal proposal (since 9:10 AM)."])
    assert.deepEqual(h.state.destinations, ["workbot_dm"], "the organization's default is a DM from Workbot")
    h.state.clock = NOW + 3 * 3_600_000
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "nothing_new" })
    assert.equal(h.state.delivered.length, 1)
  })

  test("between scheduled passes, a calendar change made by someone else wakes it early", async () => {
    const h = harness({ replies: ["NO_REPLY", message("Quarterly review moved to 3 PM tomorrow.", [{ responsibility: "calendar_changes", ref: "evt1:2026-10-20T17:47:00Z" }])] })
    await h.run()
    h.state.clock = NOW + 5 * 60_000
    h.state.events = [meeting({ updated: "2026-10-20T17:47:00Z", start: { dateTime: "2026-10-21T15:00:00-04:00" }, end: { dateTime: "2026-10-21T15:30:00-04:00" } })]
    const outcome = await h.run()
    assert.deepEqual(outcome, { status: "ran", reasons: ["calendar"], reply: "message", delivered: "sent" })
    assert.match(h.state.turns[1]?.prompt ?? "", /Woken early by the calendar/)
    assert.match(h.state.turns[1]?.prompt ?? "", /A meeting \(calendar event evt1\) moved to tomorrow at 3:00 PM .*ref evt1:2026-10-20T17:47:00Z/)
    assert.doesNotMatch(h.state.turns[1]?.prompt ?? "", /Quarterly review|Northwind/, "invite text never reaches the prompt")
    h.state.clock = NOW + 10 * 60_000
    assert.deepEqual(await h.run(), { status: "skipped", reason: "nothing_due" }, "one event wakes it once")
  })

  test("each completed pass adds to the health counters: what it asked about, what stayed quiet, what it sent", async () => {
    const h = harness({ replies: [message("A thread is waiting.", [{ responsibility: "waiting_on_you", ref: "t1" }])] })
    await h.run()
    assert.deepEqual(h.state.checks, [{
      day: "2026-10-20",
      counts: [
        { responsibility: "morning_brief", checks: 1, quiet: 1, sent: 0 },
        { responsibility: "meeting_prep", checks: 1, quiet: 1, sent: 0 },
        { responsibility: "calendar_changes", checks: 1, quiet: 1, sent: 0 },
        { responsibility: "waiting_on_you", checks: 1, quiet: 0, sent: 1 },
      ],
    }])
    const outage = harness({ replies: [{ kind: "unavailable", code: "runner_unreachable" }] })
    await outage.run()
    assert.deepEqual(outage.state.checks, [], "a pass that didn't run counts nothing")
  })

  test("past the daily limit nothing is sent, and the items are not retried later", async () => {
    const h = harness({ sentToday: 3, replies: [message("Two threads are waiting on you.", [{ responsibility: "waiting_on_you", ref: "t1" }])] })
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "daily_limit" })
    assert.deepEqual(h.state.delivered, [])
    assert.equal(h.state.ledger.get("waiting_on_you:t1"), "capped")
  })

  test("a muted responsibility is neither asked about nor delivered", async () => {
    const h = harness({ row: { overrides: { muted: ["waiting_on_you"] } }, replies: [message("A thread is waiting.", [{ responsibility: "waiting_on_you", ref: "t1" }])] })
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "nothing_new" })
    assert.doesNotMatch(h.state.turns[0]?.prompt ?? "", /- waiting_on_you:/)
  })

  test("outside working hours it reads nothing and runs nothing", async () => {
    const h = harness({ row: { timeZone: TZ } })
    h.state.clock = Date.parse("2026-10-21T01:00:00Z")
    assert.deepEqual(await h.run(), { status: "skipped", reason: "outside_hours" })
    assert.equal(h.state.calendarReads, 0)
    assert.equal(h.state.turns.length, 0)
    assert.equal(h.state.row.nextWakeAt.toISOString(), "2026-10-21T12:00:00.000Z")
  })

  test("members who turned it off or snoozed it, an organization switch off, or no destination: nothing runs", async () => {
    for (const [overrides, settings, reason] of [
      [{ status: "off" }, {}, "opted_out"],
      [{ snoozedUntil: new Date(NOW + 3_600_000) }, {}, "snoozed"],
      [{}, { enabled: false }, "off"],
      [{}, { membersStart: "opted_out" as const }, "opted_out"],
      [{}, { destination: null }, "no_destination"],
    ] as const) {
      const h = harness({ row: overrides, settings })
      assert.deepEqual(await h.run(), { status: "skipped", reason })
      assert.equal(h.state.turns.length, 0, reason)
    }
  })

  test("without the Slack app or a linked Slack account, no turn runs and the reason is recorded", async () => {
    for (const blocked of ["slack_app_not_installed", "member_not_linked"] as const) {
      const h = harness({ blocked })
      assert.deepEqual(await h.run(), { status: "skipped", reason: blocked })
      assert.equal(h.state.turns.length, 0, blocked)
      assert.equal(h.state.row.nextWakeAt.getTime(), NOW + 3_600_000)
    }
  })

  test("a kill switch between deciding and delivering wins", async () => {
    const h = harness({ allowed: [true, false], replies: [message("A thread is waiting.", [{ responsibility: "waiting_on_you", ref: "t1" }])] })
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "failed" })
    assert.deepEqual(h.state.delivered, [])
  })

  test("a runner outage retries in 15 minutes and keeps the calendar where it was", async () => {
    const h = harness({ replies: [{ kind: "unavailable", code: "runner_unreachable" }] })
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "unavailable", delivered: null })
    assert.equal(h.state.row.nextWakeAt.getTime(), NOW + 15 * 60_000)
    assert.equal(h.state.row.state, null, "nothing was recorded, so the pass and any event run on the retry")
    assert.equal(h.state.row.failures, 1)
  })
})

describe("the turn on the runner", () => {
  function fakeRunner(answer: string) {
    const calls: { method: string; path: string; body: unknown }[] = []
    const minted: { readOnly?: boolean }[] = []
    const deps: HeadlessRunnerDeps = {
      config: { url: "http://127.0.0.1:9", token: "t".repeat(40) },
      fetch: async (input, init) => {
        const url = new URL(String(input))
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        calls.push({ method: init?.method ?? "GET", path: url.pathname, body })
        const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
        if (init?.method === "PUT") return json(201, { id: url.pathname.split("/").at(-1) })
        if (init?.method === "POST" && url.pathname.endsWith("/turns")) return json(202, { state: "accepted" })
        const messageId = url.searchParams.get("messageId") ?? ""
        return json(200, {
          turns: [{ messageId, status: "completed", error: null }],
          messages: [
            { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "write_file", input: { path: "memory/notes.md" } }] },
            { role: "tool", callId: "c1", name: "write_file", isError: false },
            { role: "assistant", text: answer, toolCalls: [] },
          ],
          finalAssistantText: answer,
        })
      },
      mintToken: async (request) => {
        minted.push({ readOnly: request.readOnly })
        return { token: "mcp-token" }
      },
      maxTokenTtlMs: 3_600_000,
    }
    return { calls, minted, turnDeps: { client: createHeadlessRunnerClient(deps), sleep: async () => {}, now: Date.now, pollMs: 0, deadlineMs: 5_000 } }
  }

  const input = { actor: { userId: "user_test", organizationId }, sessionId: agentSessionId(organizationId, memberId), instructions: "Silence is the default.", model: "openai/gpt-6-luna", prompt: `${AGENT_WAKE_MARKER} Scheduled check.`, messageId: "wa_1" }

  test("its own durable session, no owner or shared memory, a read-scoped token, its own file tools kept, never deleted", async () => {
    const runner = fakeRunner("NO_REPLY")
    assert.deepEqual(await runAgentTurn(input, runner.turnDeps), { kind: "quiet" })
    const session = runner.calls.find((call) => call.method === "PUT")
    assert.equal(session?.path, `/v1/sessions/${input.sessionId}`)
    assert.ok(session && typeof session.body === "object" && session.body !== null)
    for (const key of ["owner", "memoryOf", "memoryScope", "files", "computer", "tasks"]) assert.equal(key in session.body, false, key)
    const turn = runner.calls.find((call) => call.path.endsWith("/turns"))
    assert.doesNotMatch(JSON.stringify(turn?.body), /"readOnly":true/, "credentials.readOnly would take away memory/ writes")
    assert.deepEqual(runner.minted, [{ readOnly: true }], "the MCP token is mcp:read")
    assert.equal(runner.calls.some((call) => call.method === "DELETE"), false, "its notes outlive the pass")
  })

  test("a JSON answer after tool steps is the message", async () => {
    const runner = fakeRunner(message("Quarterly review moved.", [{ responsibility: "calendar_changes", ref: "evt1:1" }]))
    assert.equal((await runAgentTurn(input, runner.turnDeps)).kind, "message")
  })
})

describe("delivery", () => {
  function deps(dm: Awaited<ReturnType<DeliveryDeps["send"]>> = { ok: true, channelId: "D1", messageTs: "1.1" }) {
    const sent: string[] = []
    const value: DeliveryDeps = {
      target: async () => (dm.ok ? { ok: true, connectionId: slackConnectionId, slackUserId: "U1" } : { ok: false, reason: dm.reason === "slack_error" ? "member_not_linked" : dm.reason }),
      send: async (call) => {
        sent.push(call.text)
        return dm
      },
    }
    return { value, sent }
  }
  const base = { organizationId, userId, text: "Quarterly review moved." }

  test("always a DM from the Workbot app, only to the member; where it landed comes back for My agent", async () => {
    const dm = deps({ ok: true, channelId: "D1", messageTs: "1.1", permalink: "https://example.slack.com/archives/D1/p11" })
    assert.deepEqual(await deliverAgentMessage(base, dm.value), { ok: true, message: { channelId: "D1", messageTs: "1.1", permalink: "https://example.slack.com/archives/D1/p11" } })
    assert.deepEqual(dm.sent, ["Quarterly review moved."])
    assert.deepEqual(await deliverAgentMessage(base, deps().value), { ok: true, message: { channelId: "D1", messageTs: "1.1", permalink: null } }, "no link from Slack, no link shown")
  })

  test("no Slack app or no linked account: nothing is sent, and the reason says which", async () => {
    assert.deepEqual(await deliverAgentMessage(base, deps({ ok: false, reason: "slack_app_not_installed" }).value), { ok: false, code: "slack_app_not_installed" })
    assert.equal(await destinationBlock({ organizationId, userId }, deps({ ok: false, reason: "member_not_linked" }).value), "member_not_linked")
    assert.deepEqual(await deliverAgentMessage(base, deps({ ok: false, reason: "slack_error", code: "ratelimited" }).value), { ok: false, code: "send_failed" })
  })
})

describe("sendWorkbotDirectMessage", () => {
  function slackDeps(input: { installed?: boolean; linked?: boolean; fail?: string } = {}) {
    const calls: { token: string; method: string; body: Record<string, unknown> }[] = []
    const deps: WorkbotDirectMessageDeps = {
      installations: async () => (input.installed === false ? [] : [{ connectionId: slackConnectionId, teamId: "T1" }]),
      linkedSlackUser: async () => (input.linked === false ? null : "U0MEMBER"),
      botToken: async () => "xoxb-bot",
      slack: (token) => async (method, body) => {
        calls.push({ token, method, body })
        if (input.fail && method === "chat.postMessage") throw new SlackApiError(input.fail)
        return method === "conversations.open" ? { ok: true, channel: { id: "D0DM" } } : { ok: true, ts: "1700000000.0001" }
      },
    }
    return { deps, calls }
  }
  const message = { organizationId, userId, text: "Quarterly review moved to 3 PM." }

  test("opens the DM with the member as the app's bot and posts there, even if they never wrote to it", async () => {
    const slack = slackDeps()
    assert.deepEqual(await sendWorkbotDirectMessage(message, slack.deps), { ok: true, channelId: "D0DM", messageTs: "1700000000.0001" })
    assert.deepEqual(slack.calls.map((call) => [call.token, call.method]), [["xoxb-bot", "conversations.open"], ["xoxb-bot", "chat.postMessage"]])
    assert.deepEqual(slack.calls[0]?.body, { users: "U0MEMBER" })
    assert.deepEqual(slack.calls[1]?.body, { channel: "D0DM", text: "Quarterly review moved to 3 PM.", unfurl_links: false, unfurl_media: false })
  })

  test("asked for, it also reads the message's Slack link; a link outside Slack or a failure there never fails the send", async () => {
    function linkDeps(permalink: unknown) {
      const calls: string[] = []
      const deps: WorkbotDirectMessageDeps = {
        installations: async () => [{ connectionId: slackConnectionId, teamId: "T1" }],
        linkedSlackUser: async () => "U0MEMBER",
        botToken: async () => "xoxb-bot",
        slack: () => async (method, body) => {
          calls.push(method)
          if (method === "chat.getPermalink") {
            assert.deepEqual(body, { channel: "D0DM", message_ts: "1700000000.0001" })
            if (permalink instanceof Error) throw permalink
            return { ok: true, permalink }
          }
          return method === "conversations.open" ? { ok: true, channel: { id: "D0DM" } } : { ok: true, ts: "1700000000.0001" }
        },
      }
      return { deps, calls }
    }
    const linked = linkDeps("https://example.slack.com/archives/D0DM/p17000000000001")
    assert.deepEqual(await sendWorkbotDirectMessage({ ...message, permalink: true }, linked.deps), { ok: true, channelId: "D0DM", messageTs: "1700000000.0001", permalink: "https://example.slack.com/archives/D0DM/p17000000000001" })
    assert.deepEqual(linked.calls, ["conversations.open", "chat.postMessage", "chat.getPermalink"])
    const permalinkOf = (result: Awaited<ReturnType<typeof sendWorkbotDirectMessage>>) => (result.ok ? result.permalink : undefined)
    assert.equal(permalinkOf(await sendWorkbotDirectMessage({ ...message, permalink: true }, linkDeps("https://evil.example/x").deps)), null)
    assert.equal(permalinkOf(await sendWorkbotDirectMessage({ ...message, permalink: true }, linkDeps(new SlackApiError("ratelimited")).deps)), null)
  })

  test("answers with a reason instead of throwing", async () => {
    assert.deepEqual(await sendWorkbotDirectMessage(message, slackDeps({ installed: false }).deps), { ok: false, reason: "slack_app_not_installed" })
    assert.deepEqual(await sendWorkbotDirectMessage(message, slackDeps({ linked: false }).deps), { ok: false, reason: "member_not_linked" })
    assert.deepEqual(await sendWorkbotDirectMessage(message, slackDeps({ fail: "messages_tab_disabled" }).deps), { ok: false, reason: "slack_error", code: "messages_tab_disabled" })
    assert.deepEqual(await sendWorkbotDirectMessage({ ...message, userId: "not-a-user" }, slackDeps().deps), { ok: false, reason: "member_not_linked" })
  })
})

describe("members' plain-language controls and the template", () => {
  test("snooze until tomorrow lasts until the next working morning; mute and unmute", () => {
    const change = policy.memberChoiceChange({ snooze: "tomorrow", mute: ["calendar_changes", "waiting_on_you"], unmute: ["waiting_on_you"] }, null, settingsOn, NOW, TZ)
    assert.equal(change.snoozedUntil?.toISOString(), "2026-10-21T12:00:00.000Z")
    assert.deepEqual(change.overrides?.muted, ["calendar_changes"])
    const unmuted = policy.memberChoiceChange({ unmute: ["morning_brief"] }, { overrides: { muted: ["morning_brief", "meeting_prep"] } }, settingsOn, NOW, TZ)
    assert.deepEqual(unmuted.overrides, { muted: ["meeting_prep"] })
    assert.deepEqual(policy.memberChoiceChange({ on: false }, null, settingsOn, NOW, TZ), { status: "off" })
  })

  test("the member's own choice wins over the organization's starting choice", () => {
    assert.equal(policy.memberAgentOn(null, settingsOn), true)
    assert.equal(policy.memberAgentOn({ status: "off" }, settingsOn), false)
    assert.equal(policy.memberAgentOn({ status: "on" }, { ...settingsOn, membersStart: "opted_out" }), true)
  })

  test("the template is an agent definition: frontmatter, then the agent's instructions", () => {
    const text = renderAgentTemplate({ responsibilities: { ...DEFAULT_AGENT_TEMPLATE.responsibilities, waiting_on_you: false }, instructions: "Ignore newsletters." })
    assert.match(text, /^---\nname: your-agent\n/)
    assert.match(text, /\nmode: primary\n/)
    assert.match(text, /\nresponsibilities: morning_brief, meeting_prep, calendar_changes\n/)
    assert.match(text, /\n---\nYou are this person's own agent/)
    assert.match(text, /## Organization instructions\nIgnore newsletters\.\n$/)
    assert.equal(mergeAgentTemplate(DEFAULT_AGENT_TEMPLATE, { dailyCap: 5 }), null, "a policy-only change saves no template version")
    assert.deepEqual(mergeAgentTemplate(DEFAULT_AGENT_TEMPLATE, { responsibilities: { morning_brief: false } })?.responsibilities.morning_brief, false)
  })
})

describe("organization policy", () => {
  test("missing or broken fields read as defaults, field by field, and invalid hours are refused", () => {
    assert.deepEqual(readWorkbotProactiveSettings(null), DEFAULT_WORKBOT_PROACTIVE_SETTINGS)
    const stored = readWorkbotProactiveSettings({ workbot: { model: "m", proactive: { enabled: true, dailyCap: 99, startHour: 20, endHour: 9, destination: { connectionId: "emc_x", channel: "C0SHARED" } } } })
    assert.equal(stored.enabled, true)
    assert.equal(stored.dailyCap, DEFAULT_WORKBOT_PROACTIVE_SETTINGS.dailyCap)
    assert.deepEqual([stored.startHour, stored.endHour], [8, 19])
    assert.equal(stored.destination, "workbot_dm", "a stored channel default reads as the Workbot DM default")
    assert.equal(mergeWorkbotProactiveSettings(DEFAULT_WORKBOT_PROACTIVE_SETTINGS, { startHour: 18, endHour: 9 }), null)
    const merged = mergeWorkbotProactiveSettings(DEFAULT_WORKBOT_PROACTIVE_SETTINGS, { enabled: true, instructions: "kept out of policy" })
    assert.ok(merged && !("instructions" in merged))
    assert.deepEqual(withWorkbotProactiveSettings({ workbot: { model: "m" } }, DEFAULT_WORKBOT_PROACTIVE_SETTINGS), { workbot: { model: "m", proactive: DEFAULT_WORKBOT_PROACTIVE_SETTINGS } })
  })
})

describe("My agent: every check is recorded for the member (workbotAgentLibrary)", () => {
  const reply = (responsibility: string, ref: string, extra: Record<string, unknown> = {}) => JSON.stringify({ message: "A thread is waiting.", items: [{ responsibility, ref }], ...extra })
  const only = (h: { state: HarnessState }) => {
    assert.equal(h.state.records.length, 1, JSON.stringify(h.state.records))
    const [record] = h.state.records
    assert.ok(record)
    return { outcome: record.outcome, reason: record.reason, summary: record.summary, kind: record.kind, responsibilities: record.responsibilities }
  }

  test("off, nothing is recorded and the agent follows the organization's limits, without the member's words", async () => {
    const h = harness({ row: { overrides: { hours: { startHour: 9, endHour: 12 } }, preferences: JSON.stringify({ v: 1, words: { always: "Payroll", never: "", when: "", how: "" }, log: [] }) } })
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "quiet", delivered: null }, "13:45 is inside the organization's 8–7")
    assert.deepEqual(h.state.records, [])
    assert.doesNotMatch(h.state.turns[0]?.prompt ?? "", /own words|Payroll/)
  })

  test("stayed quiet, sent, held by the daily limit: each check says what happened and why", async () => {
    const quiet = harness({ library: true })
    await quiet.run()
    assert.deepEqual(only(quiet), { outcome: "quiet", reason: "nothing_new", summary: "Stayed quiet: nothing new.", kind: "morning", responsibilities: [] })

    const sent = harness({ library: true, replies: [reply("waiting_on_you", "t1")] })
    await sent.run()
    assert.deepEqual(only(sent), { outcome: "sent", reason: "sent", summary: "Sent you a message about waiting on you.", kind: "morning", responsibilities: ["waiting_on_you"] })
    assert.deepEqual(sent.state.records[0]?.message, { channelId: "D0DM", messageTs: "1700000000.0001", permalink: "https://example.slack.com/archives/D0DM/p17000000000001" }, "a reference to the DM, never its text")
    sent.state.clock = NOW + 3 * 3_600_000
    await sent.run()
    assert.equal(sent.state.records.length, 2, "each check that ran is its own record")
    assert.deepEqual([sent.state.records[1]?.reason, sent.state.records[1]?.kind], ["nothing_new", "scheduled"])

    const capped = harness({ library: true, sentToday: 3, replies: [reply("waiting_on_you", "t2")] })
    await capped.run()
    assert.deepEqual(only(capped), { outcome: "quiet", reason: "daily_limit", summary: "Stayed quiet: daily limit reached (3 a day). Held a message about waiting on you.", kind: "morning", responsibilities: ["waiting_on_you"] })

    const told = harness({ library: true, row: { overrides: { muted: ["waiting_on_you"] } }, replies: [reply("waiting_on_you", "t3")] })
    await told.run()
    assert.equal(only(told).reason, "already_told")
  })

  test("outside the member's hours, inside their quiet window, or snoozed, it waited", async () => {
    const narrowed = harness({ library: true, row: { timeZone: TZ, overrides: { hours: { startHour: 9, endHour: 13 } } } })
    assert.deepEqual(await narrowed.run(), { status: "skipped", reason: "outside_hours" }, "13:45 is after their own 1 PM")
    assert.deepEqual(only(narrowed), { outcome: "waited", reason: "outside_hours", summary: "Waited: outside your hours (9 AM–1 PM).", kind: "scheduled", responsibilities: [] })
    assert.equal(narrowed.state.row.nextWakeAt.toISOString(), "2026-10-21T13:00:00.000Z", "next look at their 9 AM")
    assert.equal(narrowed.state.turns.length, 0)

    const quietWindow = harness({ library: true, row: { overrides: { quietWindow: { startHour: 12, endHour: 14 } } }, replies: [reply("calendar_changes", "c1")] })
    assert.deepEqual(await quietWindow.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "quiet_window" })
    assert.deepEqual(quietWindow.state.delivered, [])
    assert.deepEqual(only(quietWindow), { outcome: "waited", reason: "quiet_window", summary: "Waited: only urgent messages 12 PM–2 PM. Held a message about calendar changes.", kind: "morning", responsibilities: ["calendar_changes"] })
    assert.equal(quietWindow.state.ledger.size, 0, "nothing is recorded as told, so it can come up after 2 PM")
    assert.match(quietWindow.state.turns[0]?.prompt ?? "", /Between 12 PM and 2 PM only urgent messages reach them/)

    const urgent = harness({ library: true, row: { overrides: { quietWindow: { startHour: 12, endHour: 14 } } }, replies: [reply("calendar_changes", "c2", { urgent: true })] })
    assert.deepEqual(await urgent.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "sent" }, "urgent goes out inside the window")

    const snoozed = harness({ library: true, row: { snoozedUntil: new Date(NOW + 3_600_000) } })
    await snoozed.run()
    assert.deepEqual(only(snoozed), { outcome: "waited", reason: "snoozed", summary: "Waited: snoozed.", kind: "scheduled", responsibilities: [] })
  })

  test("couldn't read Gmail, couldn't reach Slack, couldn't send, couldn't run: failed, with what to do", async () => {
    const google = harness({ library: true, google: "needs_connection" })
    await google.run()
    google.state.clock = NOW + 3_600_000
    await google.run()
    assert.deepEqual(only(google), { outcome: "failed", reason: "google_disconnected", summary: "Couldn't read Gmail: reconnect Google.", kind: "scheduled", responsibilities: [] })
    assert.equal(google.state.records[0]?.at, NOW + 3_600_000, "the same cause again is one record whose time moves")

    const unlinked = harness({ library: true, blocked: "member_not_linked" })
    await unlinked.run()
    assert.deepEqual(only(unlinked).summary, "Couldn't reach you: link your Slack account to Workbot.")

    const failed = harness({ library: true, sendFails: true, replies: [reply("waiting_on_you", "t9")] })
    await failed.run()
    assert.deepEqual(only(failed), { outcome: "failed", reason: "send_failed", summary: "Couldn't send the message in Slack.", kind: "morning", responsibilities: ["waiting_on_you"] })

    const outage = harness({ library: true, replies: [{ kind: "unavailable", code: "runner_unreachable" }] })
    await outage.run()
    assert.equal(only(outage).reason, "agent_unavailable")

    const killed = harness({ library: true, allowed: [true, false], replies: [reply("waiting_on_you", "t10")] })
    await killed.run()
    assert.deepEqual(killed.state.records, [], "a kill switch right before sending is not the member's failure")
  })

  test("the member's own words reach the prompt as data they wrote", async () => {
    const words = { always: "Anything from payroll", never: "Newsletters", when: "", how: "One line each" }
    const h = harness({ library: true, row: { preferences: JSON.stringify({ v: 1, words, log: [] }) } })
    await h.run()
    const prompt = h.state.turns[0]?.prompt ?? ""
    assert.match(prompt, /in their own words in OpenWork \(data they wrote/)
    assert.match(prompt, /- Always tell me about: """Anything from payroll"""/)
    assert.match(prompt, /- Never tell me about: """Newsletters"""/)
    assert.doesNotMatch(prompt, /- When:/, "an empty field is left out")
  })

  test("a stored record reads back with a headline, a Slack link and what to do", () => {
    const view = memberAgentCheck({ id: "c1", checkedAt: new Date(NOW), kind: "scheduled", outcome: "failed", reason: "google_disconnected", summary: "Couldn't read Gmail: reconnect Google.", responsibilities: ["waiting_on_you", "send_email"], message: null })
    assert.deepEqual(view, { id: "c1", at: new Date(NOW).toISOString(), kind: "scheduled", outcome: "failed", reason: "google_disconnected", headline: "Couldn't read Gmail", summary: "Couldn't read Gmail: reconnect Google.", responsibilities: ["waiting_on_you"], slackUrl: null, fix: "reconnect_google" })
    assert.equal(memberAgentCheck({ id: "c2", checkedAt: new Date(NOW), kind: "scheduled", outcome: "exploded", reason: "nothing_new", summary: "x", responsibilities: null, message: null }), null, "a row this version can't read is left out")
    assert.equal(checkHeadline("Sent you a message about calendar changes."), "Sent you a message about calendar changes")
    const limits = { startHour: 8, endHour: 19, dailyCap: 3, quietWindow: null }
    assert.equal(describeAgentCheck({ reason: "sent", responsibilities: ["meeting_prep", "calendar_changes", "waiting_on_you"], limits }).summary, "Sent you a message about meeting prep, calendar changes and waiting on you.")
  })
})

describe("My agent: the member's words, narrower limits and undo", () => {
  const admin = { ...settingsOn, startHour: 8, endHour: 19, dailyCap: 3 }
  let next = 0
  const newId = () => `chg_${++next}`
  const change = (request: Parameters<typeof preferences.applyMemberAgentChange>[0]["request"], current: { overrides?: AgentInstanceRow["overrides"]; stored?: ReturnType<typeof preferences.emptyStoredPreferences> } = {}, source: "chat" | "page" = "chat", now = NOW) =>
    preferences.applyMemberAgentChange({ request, overrides: current.overrides ?? null, stored: current.stored ?? preferences.emptyStoredPreferences(), settings: admin, source, now, newId })

  test("a member can only narrow the admin's limits, never widen them", () => {
    assert.deepEqual(change({ hours: { startHour: 7, endHour: 17 } }), { ok: false, status: 400, error: "limit_wider_than_admin", message: "Your admin allows 8 AM–7 PM. Choose hours inside that." })
    assert.deepEqual(change({ hours: { startHour: 9, endHour: 20 } }).ok, false)
    assert.deepEqual(change({ dailyCap: 5 }), { ok: false, status: 400, error: "limit_wider_than_admin", message: "Your admin allows 3 a day. Choose 3 or fewer." })
    const narrowed = change({ hours: { startHour: 9, endHour: 17 }, dailyCap: 1 })
    assert.ok(narrowed.ok)
    assert.deepEqual([narrowed.overrides.hours, narrowed.overrides.dailyCap], [{ startHour: 9, endHour: 17 }, 1])
    const limits = preferences.memberLimits(admin, narrowed.overrides)
    assert.deepEqual([limits.startHour, limits.endHour, limits.dailyCap, limits.narrowed], [9, 17, 1, { hours: true, dailyCap: true }])
  })

  test("an admin who narrows later always wins over what the member stored", () => {
    const stored = { hours: { startHour: 9, endHour: 17 }, dailyCap: 2 }
    const later = preferences.memberLimits({ ...admin, startHour: 10, endHour: 16, dailyCap: 1 }, stored)
    assert.deepEqual([later.startHour, later.endHour, later.dailyCap], [10, 16, 1])
    const apart = preferences.memberLimits({ ...admin, startHour: 18, endHour: 22 }, stored)
    assert.deepEqual([apart.startHour, apart.endHour, apart.narrowed.hours], [18, 22, false], "hours that no longer overlap fall back to the admin's")
    assert.deepEqual(preferences.memberLimits(admin, { hours: { startHour: 12, endHour: 9 }, dailyCap: 99 }).dailyCap, 3, "unreadable stored values are ignored")
  })

  test("one chat message saves several fields as one save, says exactly what was saved, and undo reverts it", () => {
    const saved = change({ preferences: { when: "Between 12 and 2, only urgent things" }, quietWindow: { startHour: 12, endHour: 14 }, mute: ["calendar_changes"] })
    assert.ok(saved.ok)
    assert.deepEqual(saved.lines, ["When: “Between 12 and 2, only urgent things”", "Stopped: Calendar changes", "Only urgent messages 12 PM–2 PM"])
    assert.equal(saved.wake, true, "a new quiet window makes the agent look again")
    assert.equal(preferences.savedReply({ lines: saved.lines, undid: false, undoable: true }, "https://den.example/dashboard/my-bot"),
      "Saved:\n- When: “Between 12 and 2, only urgent things”\n- Stopped: Calendar changes\n- Only urgent messages 12 PM–2 PM\nReply \"undo\" to revert. My bot: https://den.example/dashboard/my-bot")
    assert.deepEqual(saved.overrides, { muted: ["calendar_changes"], quietWindow: { startHour: 12, endHour: 14 } })
    assert.deepEqual(new Set(saved.stored.log.map((entry) => entry.save)).size, 1)
    assert.ok(saved.stored.log.every((entry) => entry.source === "chat"))

    const page = change({ preferences: { how: "Bullets" } }, { overrides: saved.overrides, stored: saved.stored }, "page", NOW + 60_000)
    assert.ok(page.ok)
    const changes = preferences.memberAgentChanges(page.stored, admin)
    assert.deepEqual(changes.map((entry) => [entry.field, entry.source]), [["how", "page"], ["quietWindow", "chat"], ["calendar_changes", "chat"], ["when", "chat"]])

    const undone = change({ undo: "last" }, { overrides: page.overrides, stored: page.stored }, "chat", NOW + 120_000)
    assert.ok(undone.ok && undone.undid)
    assert.equal(undone.stored.words.how, "", "undo reverts the last save, whichever side made it")
    assert.equal(undone.stored.words.when, "Between 12 and 2, only urgent things")

    const again = change({ undo: "last" }, { overrides: undone.overrides, stored: undone.stored }, "chat", NOW + 180_000)
    assert.ok(again.ok)
    assert.deepEqual(again.stored.words, { always: "", never: "", when: "", how: "" })
    assert.deepEqual(again.overrides, { muted: [] }, "the whole chat save is reverted")
    assert.deepEqual(change({ undo: "last" }, { overrides: again.overrides, stored: again.stored }), { ok: false, status: 409, error: "nothing_to_undo", message: "There is nothing to undo." })
  })

  test("undo of one change on the page, but only the latest for its field", () => {
    const first = change({ preferences: { never: "Newsletters" } }, {}, "page")
    assert.ok(first.ok)
    const second = change({ preferences: { never: "Newsletters and alerts" } }, { stored: first.stored }, "chat", NOW + 1)
    assert.ok(second.ok)
    const older = first.stored.log[0]?.id ?? ""
    assert.deepEqual(change({ undo: older }, { stored: second.stored }), { ok: false, status: 409, error: "undo_superseded", message: "That was changed again since. Undo the newer change first." })
    const newer = second.stored.log.at(-1)?.id ?? ""
    const reverted = change({ undo: newer }, { stored: second.stored })
    assert.ok(reverted.ok)
    assert.equal(reverted.stored.words.never, "Newsletters")
    assert.deepEqual(change({ undo: newer, preferences: { how: "x" } }), { ok: false, status: 400, error: "undo_alone", message: "Undo on its own, then make the next change." })
  })

  test("asking for the admin's own hours or limit is no narrowing; the same value twice changes nothing", () => {
    const same = change({ hours: { startHour: 8, endHour: 19 }, dailyCap: 3 })
    assert.ok(same.ok)
    assert.deepEqual(same.lines, [], "nothing to log")
    const set = change({ preferences: { always: "Payroll" } })
    assert.ok(set.ok)
    const twice = change({ preferences: { always: "Payroll" } }, { stored: set.stored })
    assert.ok(twice.ok)
    assert.deepEqual(twice.lines, [])
    assert.equal(preferences.savedReply({ lines: [], undid: false, undoable: false }, "L"), "Nothing changed. My bot: L")
    assert.deepEqual(preferences.choiceLines({ on: false, snooze: "tomorrow" }), ["Turned off", "Snoozed until your next working morning"])
  })
})
