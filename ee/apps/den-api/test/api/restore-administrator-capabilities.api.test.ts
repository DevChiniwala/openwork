import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { after, test } from "node:test"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { permissionDefaultKeys } from "@openwork/types/den/permissions"
import { restoreAllAdminCapabilities } from "../../../../packages/den-db/scripts/restore-all-admin-capabilities.ts"
import { bootDen, field, isRecord, list, text, type Member } from "./harness.js"

// Real SQL on a disposable database, then requests through the real Hono app.
// Run against MySQL and MariaDB with DEN_API_TEST_MYSQL_URL. No customer data.
const den = await bootDen()
after(() => den.close())
const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("migration proof needs a SQL pool")
const pool = client
const restoredKeys = [
  "organization.update", "branding.update", "web_origins.manage", "members.update",
  "teams.manage_admin", "sso.manage", "scim.manage", "api_keys.manage",
  "desktop_policies.manage", "egress_diagnostics.manage", "billing_portal.use",
  "connections.update", "connections.delete", "permissions.manage",
]

async function migrate(name: string) {
  const sql = await readFile(new URL(`../../../../packages/den-db/drizzle/${name}.sql`, import.meta.url), "utf8")
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await pool.query(statement)
  }
}
async function rows(sql: string, args: string[] = []) {
  const [result] = await pool.query(sql, args)
  assert.ok(Array.isArray(result))
  return result.filter(isRecord)
}
async function historicalInvite(person: Member, role = "super-admin") {
  await pool.execute("UPDATE invitation i JOIN member m ON m.invite_id = i.id SET i.role = ? WHERE m.id = ? AND i.status = 'accepted'", [role, person.memberId])
  await pool.execute("UPDATE member SET role = ? WHERE id = ?", [role, person.memberId])
}
async function roleEvent(orgId: string, person: Member, role: string, shape: "legacy" | "operation", at = "2026-10-08 12:00:00.000") {
  const id = createDenTypeId("auditEvent")
  const previousRole = role === "super-admin" ? "admin" : "super-admin"
  const { buildOrganizationAuditEvent, ORGANIZATION_AUDIT_ACTIONS } = await import("../../src/audit-events.js")
  const legacy = buildOrganizationAuditEvent({
    organizationId: normalizeDenTypeId("organization", orgId), actorUserId: null,
    action: ORGANIZATION_AUDIT_ACTIONS.memberRoleUpdated,
    payload: { targetOrgMembershipId: person.memberId, targetUserId: person.userId, previousRole, nextRole: role },
  })
  const { memberRoleUpdatedEvent } = await import("../../src/audit/domain/members.js")
  const change = memberRoleUpdatedEvent(orgId, {
    id: normalizeDenTypeId("member", person.memberId), userId: normalizeDenTypeId("user", person.userId),
    role: previousRole, joinedAt: new Date("2026-10-02"), inviteId: null,
  }, role)
  assert.ok(change)
  // Exercise production serializers, then the real 0138 SQL on the persisted
  // rows. Extra envelope metadata isn't used for identifying the member.
  const payload = shape === "legacy" ? JSON.stringify(legacy.payload) : null
  const envelope = shape === "operation" ? JSON.stringify({ schemaVersion: 2, ...change }) : null
  await pool.execute("INSERT INTO audit_event (id, org_id, action, payload, envelope, created_at) VALUES (?, ?, ?, ?, ?, ?)", [id, orgId, shape === "legacy" ? "organization.member.role_updated" : "member.role_updated", payload, envelope, at])
}
async function keys(person: Member, orgId: string) {
  const result = await den.as(person, orgId)("GET", "/v1/org")
  assert.equal(result.status, 200)
  const permissions = field(result.body, "currentMember", "permissions")
  assert.ok(Array.isArray(permissions), "org response contains current effective permissions")
  return permissions
}

const org = await den.createOrg(await den.signUp("Recovery Owner"), "Recovery workspace")
const invited = await den.newMember(org.owner, org.orgId, "Invited administrator", "admin")
const promoted = await den.newMember(org.owner, org.orgId, "Promoted administrator", "admin")
const operation = await den.newMember(org.owner, org.orgId, "Audited administrator", "admin")
const claimed = await den.newMember(org.owner, org.orgId, "Claimed administrator", "admin")
const ordinary = await den.newMember(org.owner, org.orgId, "Ordinary administrator", "admin")
const member = await den.newMember(org.owner, org.orgId, "Ordinary member")
const target = await den.newMember(org.owner, org.orgId, "Role change target")
const demoted = await den.newMember(org.owner, org.orgId, "Previously demoted administrator", "admin")
const removed = await den.newMember(org.owner, org.orgId, "Removed administrator", "admin")
const inherited = await den.newMember(org.owner, org.orgId, "Inherited administrator")
const adminTeam = await den.createTeam(org.owner, org.orgId, "Existing Admin team", [inherited.memberId], { grantsOrganizationAdmin: true })
// Fixed history times precede the deployed migration; fixtures use real rows and
// the real 0138 SQL rather than a hand-written approximation of its effects.
await pool.execute("UPDATE member SET created_at = '2026-10-01', joined_at = '2026-10-02' WHERE organization_id = ?", [org.orgId])
for (const person of [invited, demoted, removed]) await historicalInvite(person)
for (const person of [promoted, operation, claimed]) await pool.execute("UPDATE member SET role = 'super-admin' WHERE id = ?", [person.memberId])
await roleEvent(org.orgId, promoted, "super-admin", "legacy")
await roleEvent(org.orgId, operation, "super-admin", "operation")
await roleEvent(org.orgId, demoted, "admin", "legacy", "2026-10-09 12:00:00.000")
await roleEvent(createDenTypeId("organization"), ordinary, "super-admin", "legacy") // another tenant is never evidence
await pool.execute("UPDATE member SET removed_at = '2026-10-09' WHERE id = ?", [removed.memberId])
await pool.execute("INSERT INTO workspace_claim (id, bootstrap_id, organization_id, token_hash, role, status, expires_at, claimed_by_user_id, claimed_at) VALUES (?, ?, ?, ?, 'super-admin', 'claimed', '2026-10-10', ?, '2026-10-08')", [createDenTypeId("workspaceClaim"), createDenTypeId("workspaceBootstrap"), org.orgId, "fixture-only-completed-claim", claimed.userId])

// Historical invite with the same email but no membership link must not count.
await pool.execute("INSERT INTO invitation (id, organization_id, email, role, status, inviter_id, expires_at) VALUES (?, ?, ?, 'super-admin', 'accepted', ?, '2026-10-10')", [createDenTypeId("invitation"), org.orgId, ordinary.email, org.owner.userId])
// Pending super-admin invites get rewritten, not used as historical authority.
const pendingId = createDenTypeId("invitation")
await pool.execute("INSERT INTO invitation (id, organization_id, email, role, status, inviter_id, expires_at) VALUES (?, ?, 'pending@example.test', 'super-admin', 'pending', ?, '2026-10-10')", [pendingId, org.orgId, org.owner.userId])

await migrate("0138_deprecate_super_admin")

// Save custom decisions and a custom team role: migration must not rewrite them.
await keys(ordinary, org.orgId) // default sets are lazily created for non-owners
const defaults = await rows("SELECT id FROM permission_set WHERE organization_id = ? AND default_key = 'admin'", [org.orgId])
const adminSet = text(defaults[0]?.id, "Admin permission set")
await pool.execute("INSERT INTO permission_set_permission (id, organization_id, permission_set_id, permission_key, status, source) VALUES (?, ?, ?, 'sso.manage', 'deny', 'user'), (?, ?, ?, 'connections.update', 'allow', 'user')", [createDenTypeId("permissionSetPermission"), org.orgId, adminSet, createDenTypeId("permissionSetPermission"), org.orgId, adminSet])
const custom = await den.as(org.owner, org.orgId)("POST", "/v1/permissions/sets", { name: "Existing custom role", teamIds: [adminTeam], permissions: [{ key: "branding.update", status: "allow" }] })
assert.equal(custom.status, 201)
const customSet = text(field(custom.body, "set", "id"), "custom permission set")
const before = await rows("SELECT * FROM permission_set_permission WHERE permission_set_id IN (?, ?) ORDER BY id", [adminSet, customSet])

test("0138 leaves accepted super-admin invitations and completed claims identifiable, not pending invites or current member roles", async () => {
  const accepted = await rows("SELECT i.role, i.status, m.role AS member_role FROM invitation i JOIN member m ON m.invite_id = i.id WHERE m.id = ?", [invited.memberId])
  assert.equal(accepted[0]?.role, "super-admin")
  assert.equal(accepted[0]?.status, "accepted")
  assert.equal(accepted[0]?.member_role, "admin")
  assert.equal((await rows("SELECT role FROM invitation WHERE id = ?", [pendingId]))[0]?.role, "admin")
  assert.equal((await rows("SELECT role FROM workspace_claim WHERE claimed_by_user_id = ?", [claimed.userId]))[0]?.role, "super-admin")
  assert.equal((await den.as(invited, org.orgId)("POST", `/v1/members/${target.memberId}/role`, { role: "member" })).status, 403)
})

test("recovery restores evidenced admins but not ordinary admins, ordinary members, inherited admins, removed people or recorded demotions", async () => {
  await migrate("0155_restore_administrator_capabilities")
  for (const person of [invited, promoted, operation, claimed]) {
    const held = await keys(person, org.orgId)
    for (const key of restoredKeys.filter((key) => key !== "sso.manage")) assert.ok(held.includes(key), `${person.name} regained ${key}`)
    assert.ok(!held.includes("sso.manage"), "explicit owner denial survives")
    for (const key of ["agent_permissions.manage", "deployments.manage"]) assert.ok(!held.includes(key), `${key} is not a former super-admin capability`)
    assert.equal((await den.as(person, org.orgId)("POST", `/v1/members/${target.memberId}/role`, { role: "admin" })).status, 200)
    assert.equal((await rows("SELECT role FROM member WHERE id = ?", [target.memberId]))[0]?.role, "admin")
    assert.equal((await den.as(person, org.orgId)("POST", `/v1/members/${target.memberId}/role`, { role: "member" })).status, 200)
    assert.equal((await rows("SELECT role FROM member WHERE id = ?", [target.memberId]))[0]?.role, "member")
  }
  const roster = await rows("SELECT m.id FROM team_member tm JOIN team t ON t.id = tm.team_id JOIN member m ON m.id = tm.org_membership_id WHERE t.organization_id = ? AND t.name LIKE 'Restored administrators (%' ORDER BY m.id", [org.orgId])
  assert.deepEqual(roster.map((row) => row.id), [invited, promoted, operation, claimed].map((person) => person.memberId).sort())
  for (const person of [ordinary, member, inherited, demoted]) {
    assert.ok(!(await keys(person, org.orgId)).includes("members.update"), person.name)
    assert.equal((await den.as(person, org.orgId)("POST", `/v1/members/${target.memberId}/role`, { role: "admin" })).status, 403)
  }
  assert.equal((await den.as(org.owner, org.orgId)("POST", `/v1/members/${target.memberId}/role`, { role: "member" })).status, 200)
  // A plain admin cannot add themself to the recovery team to escalate.
  const teams = await rows("SELECT id FROM team WHERE organization_id = ? AND name LIKE 'Restored administrators (%'", [org.orgId])
  const recoveryTeam = text(teams[0]?.id, "recovery team")
  assert.equal((await den.as(ordinary, org.orgId)("PATCH", `/v1/teams/${recoveryTeam}`, { memberIds: [invited.memberId, promoted.memberId, operation.memberId, claimed.memberId, ordinary.memberId] })).status, 403)
})

test("recovery is idempotent, preserves existing custom decisions, is visible in Permissions, and owners can revoke without replay restoring access", async () => {
  assert.deepEqual(await rows("SELECT * FROM permission_set_permission WHERE permission_set_id IN (?, ?) ORDER BY id", [adminSet, customSet]), before)
  const stored = await rows("SELECT * FROM permission_set_permission ORDER BY id")
  await migrate("0155_restore_administrator_capabilities")
  assert.deepEqual(await rows("SELECT * FROM permission_set_permission ORDER BY id"), stored)
  const sets = await den.as(org.owner, org.orgId)("GET", "/v1/permissions/sets")
  assert.equal(sets.status, 200)
  const recovered = list(field(sets.body, "sets")).find((set) => set.name === "Restored administrator permissions")
  assert.ok(recovered, "owner sees the recovery role in Permissions")
  const id = text(recovered.id, "recovery permission set")
  const revoked = await den.as(org.owner, org.orgId)("PUT", `/v1/permissions/sets/${id}/permissions`, { changes: [{ key: "members.update", status: "deny" }] })
  assert.equal(revoked.status, 200)
  await migrate("0155_restore_administrator_capabilities")
  assert.equal((await den.as(invited, org.orgId)("POST", `/v1/members/${target.memberId}/role`, { role: "member" })).status, 403)
  const teams = await rows("SELECT id FROM team WHERE organization_id = ? AND name LIKE 'Restored administrators (%'", [org.orgId])
  const teamId = text(teams[0]?.id, "recovery team")
  const remove = await den.as(org.owner, org.orgId)("PATCH", `/v1/teams/${teamId}`, { memberIds: [promoted.memberId, operation.memberId, claimed.memberId] })
  assert.equal(remove.status, 200)
  await migrate("0155_restore_administrator_capabilities")
  assert.equal((await rows("SELECT id FROM team_member WHERE team_id = ? AND org_membership_id = ?", [teamId, invited.memberId])).length, 0)
  assert.ok(!(await keys(invited, org.orgId)).includes("branding.update"), "replay never re-adds a person the owner removed")
  const archive = await den.as(org.owner, org.orgId)("DELETE", `/v1/permissions/sets/${id}`)
  assert.equal(archive.status, 204)
  await migrate("0155_restore_administrator_capabilities")
  assert.ok(!(await keys(promoted, org.orgId)).includes("branding.update"), "replay never revives an archived recovery role")
})

test("new organizations and organizations without evidence keep their existing Admin defaults", async () => {
  const fresh = await den.createOrg(await den.signUp("Fresh Owner"), "Fresh workspace")
  const admin = await den.newMember(fresh.owner, fresh.orgId, "Fresh administrator", "admin")
  assert.ok(!(await keys(admin, fresh.orgId)).includes("members.update"))
  assert.equal((await rows("SELECT id FROM team WHERE organization_id = ? AND name LIKE 'Restored administrators (%'", [fresh.orgId])).length, 0)
})

test("the opt-in broad alternative restores all existing admins and Admin teams, never members, without clobbering grants or changing future organization defaults", async () => {
  const broad = await den.createOrg(await den.signUp("Alternative Owner"), "Alternative workspace")
  const admin = await den.newMember(broad.owner, broad.orgId, "Alternative administrator", "admin")
  const teammate = await den.newMember(broad.owner, broad.orgId, "Alternative team administrator")
  const basic = await den.newMember(broad.owner, broad.orgId, "Alternative member")
  await den.createTeam(broad.owner, broad.orgId, "Alternative Admin team", [teammate.memberId], { grantsOrganizationAdmin: true })
  const { db } = await import("../../src/db.js")
  const beforeDryRun = await rows("SELECT * FROM permission_set_permission ORDER BY id")
  const setsBeforeDryRun = await rows("SELECT * FROM permission_set ORDER BY id")
  const dryRun = await restoreAllAdminCapabilities(db, { apply: false })
  assert.ok(dryRun.rowsPlanned > 0)
  assert.equal(dryRun.rowsInserted, 0)
  assert.deepEqual(await rows("SELECT * FROM permission_set_permission ORDER BY id"), beforeDryRun)
  assert.deepEqual(await rows("SELECT * FROM permission_set ORDER BY id"), setsBeforeDryRun)
  const applied = await restoreAllAdminCapabilities(db, { apply: true })
  assert.ok(applied.rowsInserted > 0)
  assert.deepEqual(await rows("SELECT * FROM permission_set_permission WHERE permission_set_id IN (?, ?) AND source <> 'migration' ORDER BY id", [adminSet, customSet]), before)
  for (const person of [admin, teammate]) {
    const held = await keys(person, broad.orgId)
    for (const key of [...permissionDefaultKeys("admin"), ...restoredKeys]) assert.ok(held.includes(key), `${person.name}: ${key}`)
    assert.equal((await den.as(person, broad.orgId)("POST", `/v1/members/${basic.memberId}/role`, { role: "member" })).status, 200)
  }
  assert.equal((await den.as(basic, broad.orgId)("POST", `/v1/members/${basic.memberId}/role`, { role: "admin" })).status, 403)
  const snapshot = await rows("SELECT * FROM permission_set_permission ORDER BY id")
  assert.equal((await restoreAllAdminCapabilities(db, { apply: true })).rowsInserted, 0)
  assert.deepEqual(await rows("SELECT * FROM permission_set_permission ORDER BY id"), snapshot)
  const adminSets = await rows("SELECT id FROM permission_set WHERE organization_id = ? AND default_key = 'admin'", [broad.orgId])
  const id = text(adminSets[0]?.id, "broad Admin set")
  const revoke = await den.as(broad.owner, broad.orgId)("PUT", `/v1/permissions/sets/${id}/permissions`, { changes: [{ key: "members.update", status: "deny" }] })
  assert.equal(revoke.status, 200)
  assert.equal((await restoreAllAdminCapabilities(db, { apply: true })).rowsInserted, 0)
  assert.equal((await den.as(admin, broad.orgId)("POST", `/v1/members/${basic.memberId}/role`, { role: "member" })).status, 403)
  const later = await den.createOrg(await den.signUp("Later Owner"), "Later workspace")
  const laterAdmin = await den.newMember(later.owner, later.orgId, "Later administrator", "admin")
  assert.ok(!(await keys(laterAdmin, later.orgId)).includes("members.update"))
})
