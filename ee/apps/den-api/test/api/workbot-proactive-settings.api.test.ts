import assert from "node:assert/strict"
import { after, test } from "node:test"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { ConfigObjectTable, ConfigObjectVersionTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { DEFAULT_AGENT_TEMPLATE, DEFAULT_WORKBOT_PROACTIVE_SETTINGS } from "@openwork/types/den/workbot-proactive"
import { bootDen, field, summary } from "./harness.js"

// Members' agents: behind workbotProactive and Workbot on the deployment. Admin settings are read with View/Manage
// OpenWork Models and changed only with Manage; each member changes only their own agent. No runner, Slack or
// Google is contacted.
const den = await bootDen({ env: { DEN_WORKBOT_URL: "http://localhost:3020" } })
after(() => den.close())
const path = "/v1/org/workbot-settings/proactive"

test("off until the feature is on and Workbot is deployed; then defaults, policy saved per field, template saved as versions", async () => {
  const workspace = await den.createOrg(await den.signUp("Agent Owner"), "Agent workspace")
  const owner = den.as(workspace.owner, workspace.orgId)

  const hidden = await owner("GET", path)
  assert.equal(hidden.status, 404, summary(hidden))
  assert.equal(field(hidden.body, "feature"), "workbotProactive")
  assert.equal((await den.setFeature(workspace.orgId, "workbotProactive", true)).status, 200)

  const previous = process.env.DEN_WORKBOT_URL
  delete process.env.DEN_WORKBOT_URL
  try {
    const withoutWorkbot = await owner("GET", path)
    assert.equal(withoutWorkbot.status, 404, summary(withoutWorkbot))
    assert.equal(field(withoutWorkbot.body, "feature"), "workbot")
  } finally {
    process.env.DEN_WORKBOT_URL = previous
  }

  const first = await owner("GET", path)
  assert.equal(first.status, 200, summary(first))
  assert.deepEqual(field(first.body, "settings"), DEFAULT_WORKBOT_PROACTIVE_SETTINGS)
  assert.deepEqual(field(first.body, "template"), { ...DEFAULT_AGENT_TEMPLATE, versionId: null, version: 1 }, "the built-in template is version 1")
  assert.deepEqual(field(first.body, "destinations"), [], "no Slack connection yet")
  assert.equal(field(first.body, "runnerReady"), false, "no headless runner is configured")

  const { db } = await import("../../src/db.js")
  await db.update(OrganizationTable).set({ metadata: { workbot: { model: "openai/gpt-6-luna" } } }).where(eq(OrganizationTable.id, workspace.orgId))

  const saved = await owner("PUT", path, { enabled: true, leadMinutes: 30, membersStart: "opted_out" })
  assert.equal(saved.status, 200, summary(saved))
  assert.deepEqual(field(saved.body, "settings"), { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS, enabled: true, leadMinutes: 30, membersStart: "opted_out" })
  assert.equal(field(saved.body, "template", "version"), 1, "a policy change saves no template version")
  const [stored] = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, workspace.orgId))
  assert.equal(field(stored?.metadata, "workbot", "model"), "openai/gpt-6-luna", "the default model is kept")

  const edited = await owner("PUT", path, { responsibilities: { waiting_on_you: false }, instructions: "Ignore newsletters." })
  assert.equal(edited.status, 200, summary(edited))
  assert.equal(field(edited.body, "template", "version"), 2)
  assert.equal(field(edited.body, "template", "responsibilities", "waiting_on_you"), false)
  const again = await owner("PUT", path, { instructions: "Ignore newsletters and automated alerts." })
  assert.equal(field(again.body, "template", "version"), 3)
  const objects = await db
    .select({ id: ConfigObjectTable.id, objectType: ConfigObjectTable.objectType, title: ConfigObjectTable.title })
    .from(ConfigObjectTable)
    .where(and(eq(ConfigObjectTable.organizationId, workspace.orgId), eq(ConfigObjectTable.objectType, "agent")))
  assert.equal(objects.length, 1, "one Your agent config object of type agent")
  const versions = await db.select({ raw: ConfigObjectVersionTable.rawSourceText }).from(ConfigObjectVersionTable).where(eq(ConfigObjectVersionTable.configObjectId, objects[0]?.id ?? "cob_missing"))
  assert.equal(versions.length, 2)
  assert.ok(versions.every((version) => version.raw?.startsWith("---\nname: your-agent\n")), "each version is an agent definition")

  for (const invalid of [{ leadMinutes: 7 }, { dailyCap: 50 }, { workingDays: "weekends" }, { unknown: true }, { instructions: "x".repeat(601) }]) {
    const refused = await owner("PUT", path, invalid)
    assert.equal(refused.status, 400, `${JSON.stringify(invalid)}: ${summary(refused)}`)
  }
  const backwards = await owner("PUT", path, { startHour: 18, endHour: 9 })
  assert.equal(backwards.status, 400, summary(backwards))
  assert.equal(field(backwards.body, "error"), "invalid_working_hours")
  const nowhere = await owner("PUT", path, { destination: { connectionId: "emc_01k0000000000000000000000" } })
  assert.equal(nowhere.status, 400, summary(nowhere))
  assert.equal(field(nowhere.body, "error"), "unknown_destination")
  assert.equal(field((await owner("GET", path)).body, "settings", "startHour"), 8, "a refused change saves nothing")
})

test("each member reads and changes only their own agent, in plain terms", async () => {
  const workspace = await den.createOrg(await den.signUp("Agent Member Owner"), "Agent members")
  assert.equal((await den.setFeature(workspace.orgId, "workbotProactive", true)).status, 200)
  const owner = den.as(workspace.owner, workspace.orgId)
  assert.equal((await owner("PUT", path, { enabled: true })).status, 200)
  const member = await den.newMember(workspace.owner, workspace.orgId, "Agent member")
  const call = den.as(member, workspace.orgId)

  const before = await call("GET", "/v1/me/agent")
  assert.equal(before.status, 200, summary(before))
  assert.equal(field(before.body, "available"), true)
  assert.equal(field(before.body, "on"), true, "members start opted in")
  assert.equal(field(before.body, "destination"), null)

  const muted = await call("PUT", "/v1/me/agent", { mute: ["calendar_changes"], snooze: "tomorrow" })
  assert.equal(muted.status, 200, summary(muted))
  const responsibilities = field(muted.body, "responsibilities")
  assert.ok(Array.isArray(responsibilities))
  assert.deepEqual(responsibilities.map((entry) => [field(entry, "id"), field(entry, "muted")]), [["morning_brief", false], ["meeting_prep", false], ["calendar_changes", true], ["waiting_on_you", false]])
  assert.equal(typeof field(muted.body, "snoozedUntil"), "string")
  const off = await call("PUT", "/v1/me/agent", { on: false, snooze: null })
  assert.equal(field(off.body, "on"), false)
  assert.equal(field(off.body, "snoozedUntil"), null)
  assert.equal(field((await owner("GET", "/v1/me/agent")).body, "on"), true, "another member's agent is untouched")
  assert.equal((await call("PUT", "/v1/me/agent", { mute: ["send_email"] })).status, 400)
  assert.equal((await call("PUT", "/v1/me/agent", { destination: { connectionId: "emc_01k0000000000000000000000" } })).status, 400)
})

test("the ledger delivers each item at most once and leases keep two instances off one agent", async () => {
  const workspace = await den.createOrg(await den.signUp("Ledger Owner"), "Agent ledger")
  const repository = await import("../../src/workbot-proactive/repository.js")
  const { normalizeDenTypeId } = await import("@openwork-ee/utils/typeid")
  const organizationId = normalizeDenTypeId("organization", workspace.orgId)
  const memberId = normalizeDenTypeId("member", workspace.owner.memberId)
  const now = new Date()

  await repository.ensureAgentInstances(organizationId, [memberId])
  await repository.ensureAgentInstances(organizationId, [memberId])
  const claimedRows = await repository.claimDueAgents(50, now)
  const claimed = claimedRows.find((row) => row.memberId === memberId)
  assert.ok(claimed)
  assert.equal(claimedRows.filter((row) => row.memberId === memberId).length, 1, "ensuring twice keeps one agent")
  assert.equal((await repository.claimDueAgents(10, now)).filter((row) => row.memberId === memberId).length, 0, "a leased agent is not claimed twice")
  assert.equal(await repository.holdsAgentLease(claimed), true)

  const item = { responsibility: "waiting_on_you" as const, ref: "thread-1" }
  const first = await repository.reserveAgentDelivery({ organizationId, memberId, item })
  assert.ok(first)
  assert.equal(await repository.reserveAgentDelivery({ organizationId, memberId, item }), null, "only one insert wins")
  await repository.finishAgentDelivery(first, "sent")
  await repository.reserveAgentDelivery({ organizationId, memberId, item: { responsibility: "calendar_changes", ref: "evt2:x" }, outcome: "folded" })
  const told = await repository.toldAgentItems(memberId, [item, { responsibility: "calendar_changes", ref: "evt2:x" }, { responsibility: "calendar_changes", ref: "evt3:y" }])
  assert.deepEqual([...told].sort(), ["calendar_changes:evt2:x", "waiting_on_you:thread-1"])
  assert.equal(await repository.agentSentSince(memberId, new Date(now.getTime() - 60_000)), 1, "folded items don't count as messages")

  assert.equal(await repository.settleAgent(claimed, { nextWakeAt: new Date(now.getTime() + 300_000), state: "{}", timeZone: "UTC" }), true)
  assert.equal(await repository.settleAgent(claimed, { nextWakeAt: now }), false, "a released lease cannot settle again")
  await repository.saveMemberChoices(organizationId, memberId, { status: "on" }, now)
  const after = await repository.readAgentInstance(memberId)
  assert.equal(after?.status, "on")
  assert.equal(after?.state, "{}", "the state is stored (encrypted at rest) and read back")
  assert.equal(after?.nextWakeAt.getTime(), now.getTime(), "turning on makes the agent due now")
})

test("members without Manage OpenWork Models can't change agent settings; without either permission they can't read them", async () => {
  const workspace = await den.createOrg(await den.signUp("Agent Admin"), "Agent permissions")
  assert.equal((await den.setFeature(workspace.orgId, "workbotProactive", true)).status, 200)
  const member = await den.newMember(workspace.owner, workspace.orgId, "Plain member")
  const call = den.as(member, workspace.orgId)
  assert.equal((await call("GET", path)).status, 403)
  assert.equal((await call("PUT", path, { enabled: true })).status, 403)

  const owner = den.as(workspace.owner, workspace.orgId)
  const viewer = await den.newMember(workspace.owner, workspace.orgId, "Viewer")
  const teamId = await den.createTeam(workspace.owner, workspace.orgId, "Viewers", [viewer.memberId])
  assert.equal((await owner("POST", "/v1/permissions/sets", { teamId, permissions: [{ key: "inference.view", status: "allow" }] })).status, 201)
  const view = den.as(viewer, workspace.orgId)
  assert.equal((await view("GET", path)).status, 200)
  assert.equal((await view("PUT", path, { enabled: true })).status, 403)
  assert.equal(field((await owner("GET", path)).body, "settings", "enabled"), false)
})
