import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { adminOpportunitiesSchema } from "@openwork/types/den/admin-organization"
import { bootDen, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("Opportunities fixtures require the disposable MySQL harness")
const query = (statement: string, values: (string | number | null)[] = []) => client.execute(statement, values)
const admin = await den.signUp("Platform Admin", process.env.DEN_BOOTSTRAP_ADMIN_EMAILS)
const owner = await den.signUp("Work Owner", `owner+${den.stamp}@studio.example.test`)
const peer = await den.signUp("Work Peer", `peer+${den.stamp}@studio.example.test`)
const work = await den.createOrg(owner, "Workplace example")
const teammate = await den.join(owner, work.orgId, peer)
const personalOwner = await den.signUp("Personal Owner", `owner+${den.stamp}@gmail.com`)
const personal = await den.createOrg(personalOwner, "Personal example")
const personalPeer = await den.signUp("Personal Peer", `peer+${den.stamp}@outlook.com`)
await den.join(personalOwner, personal.orgId, personalPeer)
const soloOwner = await den.signUp("Solo Owner", `solo+${den.stamp}@solo.example.test`)
const solo = await den.createOrg(soloOwner, "Solo example")
const quiet = await den.createOrg(owner, "No observed usage")
await den.join(owner, quiet.orgId, peer)
await query("UPDATE user SET email_verified = true WHERE id IN (?, ?, ?, ?, ?)", [owner.userId, peer.userId, personalOwner.userId, personalPeer.userId, soloOwner.userId])
await query("UPDATE user SET email = ? WHERE id = ?", [`peer+${den.stamp}@STUDIO.example.test`, peer.userId])
await query("UPDATE member SET joined_at = DATE_SUB(NOW(3), INTERVAL 60 DAY) WHERE organization_id IN (?, ?, ?, ?)", [work.orgId, personal.orgId, solo.orgId, quiet.orgId])

// These rows are setup, not observations. The public API must exclude pending,
// removed and provisional identities, and refuse cross-organization attribution.
const removed = createDenTypeId("member")
const pending = createDenTypeId("member")
const setupAgent = createDenTypeId("member")
const setupUser = await den.signUp("Provisional User")
await query("INSERT INTO member (id, organization_id, user_id, joined_at, removed_at) VALUES (?, ?, ?, DATE_SUB(NOW(3), INTERVAL 5 DAY), NOW(3))", [removed, work.orgId, personalOwner.userId])
await query("INSERT INTO member (id, organization_id, user_id, joined_at) VALUES (?, ?, ?, NULL)", [pending, work.orgId, soloOwner.userId])
await query("INSERT INTO member (id, organization_id, user_id, is_setup_agent, joined_at) VALUES (?, ?, ?, 1, DATE_SUB(NOW(3), INTERVAL 5 DAY))", [setupAgent, work.orgId, setupUser.userId])
async function activity(orgId: string, memberId: string, minutesAgo: number) {
  await query("INSERT INTO telemetry_event (id, org_id, member_id, event_type, event_timestamp, source) VALUES (?, ?, ?, 'user.active', DATE_SUB(NOW(3), INTERVAL ? MINUTE), 'app')", [createDenTypeId("telemetryEvent"), orgId, memberId, minutesAgo])
}
await activity(work.orgId, work.owner.memberId, 10)
await activity(work.orgId, teammate.memberId, 120)
await activity(personal.orgId, personal.owner.memberId, 4 * 1_440)
await activity(solo.orgId, solo.owner.memberId, 20)
await activity(work.orgId, removed, 1)
await activity(work.orgId, pending, 1)
await activity(work.orgId, setupAgent, 1)
await activity(personal.orgId, work.owner.memberId, 1)
// Future and pre-membership events must not make an organization active.
await activity(quiet.orgId, await den.memberIdOf(owner, quiet.orgId, owner.email), -60)
await activity(quiet.orgId, await den.memberIdOf(owner, quiet.orgId, owner.email), 70 * 1_440)

for (const [type, status, deleted] of [["skill", "active", 0], ["mcp", "active", 0], ["skill", "inactive", 0], ["mcp", "active", 1]]) {
  await query("INSERT INTO config_object (id, organization_id, object_type, source_mode, title, status, created_by_org_membership_id, deleted_at) VALUES (?, ?, ?, 'cloud', 'Example configuration', ?, ?, IF(? = 1, NOW(3), NULL))", [createDenTypeId("configObject"), work.orgId, type, status, work.owner.memberId, deleted])
}

async function report(search = "") {
  const response = await den.request(admin.token, "GET", `/v1/admin/opportunities${search ? `?${search}` : ""}`)
  assert.equal(response.status, 200, summary(response))
  assert.equal(response.headers.get("cache-control"), "no-store")
  return adminOpportunitiesSchema.parse(response.body)
}

test("only a platform admin can read adoption signals, including organization owners", async () => {
  assert.equal((await den.request(null, "GET", "/v1/admin/opportunities")).status, 401)
  assert.equal((await den.request(owner.token, "GET", "/v1/admin/opportunities")).status, 403)
  assert.equal((await den.request(peer.token, "GET", "/v1/admin/opportunities")).status, 403)
  const data = await report()
  assert.deepEqual(data.organizations.map(row => row.id), [work.orgId, personal.orgId])
  assert.ok(!JSON.stringify(data).includes(owner.email))
  assert.ok(!JSON.stringify(data).includes("Example configuration"))
})

test("current human users, verified email signals and Cloud counts stay scoped to their organization", async () => {
  const data = await report("companyEmail=1&setup=both")
  assert.equal(data.page.total, 1)
  const row = data.organizations[0]
  assert.ok(row)
  assert.equal(row.id, work.orgId)
  assert.equal(row.members, 2)
  assert.equal(row.activeMembers, 2)
  assert.equal(row.companyEmailMembers, 2)
  assert.equal(row.companyDomain, "studio.example.test")
  assert.equal(row.companyDomainCount, 1)
  assert.equal(row.skills, 1)
  assert.equal(row.mcpConnections, 1)
  const minutesAgo = (Date.now() - Date.parse(row.lastActiveAt)) / 60_000
  assert.ok(minutesAgo >= 9 && minutesAgo < 12, `last observation was ${minutesAgo} minutes ago`)
  const personalRow = (await report()).organizations.find(row => row.id === personal.orgId)
  assert.equal(personalRow?.companyDomain, null)
  assert.equal(personalRow?.companyEmailMembers, 0)
})

test("filters, full-result pagination and domain search run before the page limit", async () => {
  const first = await report("minMembers=1&limit=1")
  const second = await report("minMembers=1&limit=1&offset=1")
  assert.equal(first.page.total, 3)
  assert.equal(first.page.hasMore, true)
  assert.equal(first.organizations[0]?.id, work.orgId)
  assert.equal(second.organizations[0]?.id, solo.orgId)
  assert.equal((await report("search=studio.example.test")).page.total, 1)
  assert.equal((await report("search=%25_")).page.total, 0)
  assert.equal((await report("minMembers=5")).page.total, 0)
  assert.equal((await report("setup=skills")).page.total, 1)
  const invalid = await den.request(admin.token, "GET", "/v1/admin/opportunities?days=365")
  assert.equal(invalid.status, 400)
})

test("unverified company addresses do not qualify, and missing telemetry is not invented from sign-ins", async () => {
  await query("UPDATE user SET email_verified = false WHERE id IN (?, ?)", [owner.userId, peer.userId])
  assert.equal((await report("companyEmail=1")).page.total, 0)
  const data = await report("minMembers=1&days=90")
  assert.ok(!data.organizations.some(row => row.id === quiet.orgId))
})
