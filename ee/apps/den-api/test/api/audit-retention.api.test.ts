/**
 * Audit history is kept for 90 days unless a platform admin sets another
 * window (1 to 365 days) for the organization. The change is recorded in the
 * organization's audit log. History older than the window is deleted only
 * once the auditRetentionCleanup feature is on for the organization.
 */
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { bootDen, field, list, summary, type Member } from "./harness.js"

const MAINTENANCE_TOKEN = "den-api-test-maintenance-token-0123456789"
const den = await bootDen({ env: { DEN_AUDIT_SELF_HOSTED_ENABLED: "true", DEN_MAINTENANCE_TOKEN: MAINTENANCE_TOKEN } })
after(() => den.close())

let orgId = ""
let owner: Member
const retentionPath = () => `/v1/admin/organizations/${encodeURIComponent(orgId)}/audit-retention`

before(async () => {
  const created = await den.createOrg(await den.signUp("Retention Owner"), "Retention org")
  orgId = created.orgId
  owner = created.owner
})

async function usage() {
  const read = await den.as(owner, orgId)("GET", "/v1/audit/usage")
  assert.equal(read.status, 200, summary(read))
  return read
}

/** Audit capture is asynchronous: poll the owner's history for one action. */
async function operationsWith(action: string, until: (operations: Record<string, unknown>[]) => boolean) {
  const deadline = Date.now() + 15_000
  for (;;) {
    const listed = await den.as(owner, orgId)("GET", `/v1/audit/operations?limit=50&action=${encodeURIComponent(action)}`)
    assert.equal(listed.status, 200, summary(listed))
    const operations = list(field(listed.body, "operations"))
    if (until(operations) || Date.now() > deadline) return operations
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function runRetention() {
  const run = await den.request(null, "POST", "/internal/audit/retention/run", { headers: { authorization: `Bearer ${MAINTENANCE_TOKEN}` } })
  assert.equal(run.status, 200, summary(run))
  return run
}

test("a new organization keeps history for 90 days and nothing is deleted", async () => {
  const read = await usage()
  assert.equal(field(read.body, "policy", "retentionDays"), 90)
  assert.equal(field(read.body, "cleanup"), "dry_run")
  const admin = await den.asPlatformAdmin("GET", retentionPath())
  assert.equal(admin.status, 200, summary(admin))
  assert.equal(field(admin.body, "retentionDays"), 90)
  assert.equal(field(admin.body, "defaultRetentionDays"), 90)
  assert.equal(field(admin.body, "maximumRetentionDays"), 365)
  assert.equal(field(admin.body, "available"), true)
  assert.equal(field(admin.body, "cleanupEnabled"), false)
  assert.equal(typeof field(admin.body, "revision"), "number")
})

test("only platform admins change retention, within 1 to 365 days, against the current revision", async () => {
  const current = await den.asPlatformAdmin("GET", retentionPath())
  const revision = Number(field(current.body, "revision"))
  const member = await den.as(owner, orgId)("PUT", retentionPath(), { retentionDays: 30, expectedRevision: revision })
  assert.equal(member.status, 403, summary(member))
  for (const retentionDays of [0, 366]) {
    const refused = await den.asPlatformAdmin("PUT", retentionPath(), { retentionDays, expectedRevision: revision })
    assert.equal(refused.status, 400, summary(refused))
  }

  const saved = await den.asPlatformAdmin("PUT", retentionPath(), { retentionDays: 30, expectedRevision: revision })
  assert.equal(saved.status, 200, summary(saved))
  assert.equal(field(saved.body, "retentionDays"), 30)
  assert.equal(field(saved.body, "revision"), revision + 1)
  const stale = await den.asPlatformAdmin("PUT", retentionPath(), { retentionDays: 60, expectedRevision: revision })
  assert.equal(stale.status, 409, summary(stale))
  assert.equal(field(stale.body, "error"), "audit_policy_changed")
  const same = await den.asPlatformAdmin("PUT", retentionPath(), { retentionDays: 30, expectedRevision: revision + 1 })
  assert.equal(field(same.body, "revision"), revision + 1, "the same value changes nothing")
  assert.equal(field(await usage().then((read) => read.body), "policy", "retentionDays"), 30)

  const recorded = await operationsWith("audit.retention.updated", (operations) => operations.length > 0)
  assert.equal(recorded.length, 1, "one event for one change")
  const events = await den.as(owner, orgId)("GET", `/v1/audit/operations/${String(recorded[0]?.id)}/events?limit=10`)
  const event = list(field(events.body, "events")).find((entry) => entry.action === "audit.retention.updated")
  assert.equal(field(event, "category"), "lifecycle")
  assert.equal(field(event, "operation", "origin"), "platform_admin")
  assert.equal(field(event, "actor", "type"), "user")
  assert.equal(field(event, "actor", "memberId"), undefined, "a platform admin acts without a membership")
  assert.equal(field(event, "changes", "before", "retentionDays"), 90)
  assert.equal(field(event, "changes", "after", "retentionDays"), 30)
})

test("history older than the window is deleted only once cleanup is on for the organization", async () => {
  await den.createTeam(owner, orgId, "Retention team", [])
  assert.ok((await operationsWith("team.create.succeeded", (operations) => operations.length > 0)).length > 0)
  await den.arrangeAuditOperationsAged(orgId, 40)

  const off = await runRetention()
  assert.equal(field(off.body, "deletedOperations"), 0, "cleanup off deletes nothing")
  assert.equal((await operationsWith("team.create.succeeded", () => true)).length, 1)

  const enabled = await den.setFeature(orgId, "auditRetentionCleanup", true)
  assert.equal(enabled.status, 200, summary(enabled))
  assert.equal(field(await den.asPlatformAdmin("GET", retentionPath()).then((read) => read.body), "cleanupEnabled"), true)
  const on = await runRetention()
  assert.ok(Number(field(on.body, "deletedOperations")) > 0, summary(on))
  assert.ok(Number(field(on.body, "deletedEvents")) > 0, summary(on))
  assert.equal(field(on.body, "failed"), 0)
  assert.equal((await operationsWith("team.create.succeeded", () => true)).length, 0, "history older than 30 days is gone")
  assert.equal(field((await usage()).body, "cleanup"), "age_based")

  const again = await runRetention()
  assert.equal(field(again.body, "deletedOperations"), 0, "recent history is kept")
})

test("the maintenance endpoint needs the maintenance token", async () => {
  const anonymous = await den.request(null, "POST", "/internal/audit/retention/run")
  assert.equal(anonymous.status, 401, summary(anonymous))
  const wrong = await den.request(null, "POST", "/internal/audit/retention/run", { headers: { authorization: "Bearer wrong-token-wrong-token-wrong" } })
  assert.equal(wrong.status, 401, summary(wrong))
})
