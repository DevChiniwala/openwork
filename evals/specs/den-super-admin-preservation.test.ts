import assert from "node:assert/strict"
import { test } from "@openwork/testkit"
import { currentTestEvidence } from "@openwork/test-evidence"
import { UpgradeLab, buildCohort, field, images, preservedKeys } from "../support/den-super-admin-upgrade.ts"

// Local Podman, linux/arm64 published images, ~1 GiB RAM and cached images are
// required. Explicit opt-in avoids creating a Docker VM in an ordinary PR run.
// OPENWORK_SUPER_ADMIN_UPGRADE=1 EXP_O2_ENGINE=mysql (reference) or mariadb (compatibility).
test("pre-deprecation upgrades preserve only the active super-admin roster; later databases and revocations stay unchanged", { timeout: 600_000 }, async ({ skip }) => {
  if (process.env.OPENWORK_SUPER_ADMIN_UPGRADE !== "1") skip("needs: opt-in local published-image upgrade lab (OPENWORK_SUPER_ADMIN_UPGRADE=1), Podman and arm64 images")
  const engine = process.env.EXP_O2_ENGINE === "mariadb" ? "mariadb" : "mysql"
  const lab = new UpgradeLab(engine)
  await lab.start()
  try {
    const version = lab.rows("SELECT VERSION() AS version")[0].version
    assert.ok(version.startsWith(engine === "mysql" ? "8.4." : "11.4."))
    console.log(`Reference/compatibility database: ${version}`)
    lab.publishedMigrate(images.before)
    await lab.serve(images.before)
    const cohort = await buildCohort(lab)
    const before = lab.snapshot() // private, in-memory only; never evidence or a Git artifact
    const unchangedTeam = lab.rows("SELECT id,name,member_count,grants_organization_admin FROM team ORDER BY id")
    const unchangedMembers = lab.rows("SELECT * FROM team_member ORDER BY id")
    lab.stopApi()
    lab.branchMigrate()
    await lab.serve(images.after)
    const owner = await lab.login(cohort.owner.email)
    const teams = lab.rows("SELECT * FROM team WHERE name LIKE 'Super Admins (%)'")
    assert.equal(teams.length, 1, "no new team in the second org without super-admins")
    const team = teams[0]
    assert.equal(team.organization_id, cohort.orgId)
    assert.equal(team.grants_organization_admin, "0", "ordinary team, not an Admin-team default grant")
    const expected = ["promoted", "invited", "superteam", "multi"]
    const roster = lab.rows(`SELECT org_membership_id FROM team_member WHERE team_id='${team.id}' ORDER BY org_membership_id`).map(row => row.org_membership_id)
    assert.deepEqual(roster, expected.map(label => cohort.ids[label]).sort(), "exact current role cohort; no demotions, removals, owners, case-insensitive or substring matches")
    assert.equal(Number(team.member_count), expected.length)
    assert.deepEqual(lab.rows(`SELECT id,name,member_count,grants_organization_admin FROM team WHERE id<>'${team.id}' ORDER BY id`), unchangedTeam)
    assert.deepEqual(lab.rows(`SELECT * FROM team_member WHERE team_id<>'${team.id}' ORDER BY id`), unchangedMembers)
    const sets = lab.rows("SELECT * FROM permission_set WHERE default_key IS NULL")
    assert.equal(sets.length, 1)
    const set = sets[0]
    assert.equal(set.name, "Super Admins Permissions")
    const grants = lab.rows(`SELECT permission_key,status,source FROM permission_set_permission WHERE permission_set_id='${set.id}' ORDER BY permission_key`)
    assert.deepEqual(grants, preservedKeys.map(permission_key => ({ permission_key, status: "allow", source: "migration" })))
    const pending = lab.rows(`SELECT role,status FROM invitation WHERE organization_id='${cohort.orgId}' AND email='exp-o2-pending@example.test'`)
    assert.deepEqual(pending, [{ role: "admin", status: "pending" }])

    currentTestEvidence()?.recordAssertionEvidence("Only active stored super-admins get a visible team and exactly 14 grants", `${version}: promoted/invited/superteam/multi selected; owners, demoted, removed, ordinary admins, members, case/substring controls and pending invitation excluded; second org and existing same-name Admin team unchanged`, true)
    const access: Record<string, string[]> = {}
    for (const label of [...expected, "admin", "member", "demoted", "teamadmin", "wrongcase", "substring", "owner", "ownercombo"]) {
      const who = await lab.login(cohort.identities[label].email)
      const result = await lab.call(who, "/v1/org")
      assert.equal(result.status, 200, label)
      const permissions = field(result.data, "currentMember", "permissions")
      assert.ok(Array.isArray(permissions) && permissions.every(key => typeof key === "string"))
      access[label] = permissions
      if (expected.includes(label)) {
        assert.equal(permissions.length, 55, `${label}: 41 released defaults + 14 preserved`)
        for (const key of preservedKeys) assert.ok(permissions.includes(key), `${label}: ${key}`)
        assert.equal(permissions.includes("agent_permissions.manage"), false)
        assert.equal(permissions.includes("deployments.manage"), false)
        const changed = await lab.call(who, `/v1/members/${cohort.ids.member}/role`, "POST", { role: "admin" })
        assert.equal(changed.status, 200, `${label} can change roles`)
        assert.equal(lab.rows(`SELECT role FROM member WHERE id='${cohort.ids.member}'`)[0].role, "admin")
        assert.equal((await lab.call(who, `/v1/members/${cohort.ids.member}/role`, "POST", { role: "member" })).status, 200)
        // A real permission write, not a missing-resource authorization probe.
        const saved = await lab.call(who, `/v1/permissions/sets/${set.id}/permissions`, "PUT", { changes: [{ key: "branding.update", status: "deny" }] })
        assert.equal(saved.status, 200, `${label} can manage the preserved set through its ordinary API`)
        assert.equal(lab.rows(`SELECT status FROM permission_set_permission WHERE permission_set_id='${set.id}' AND permission_key='branding.update' ORDER BY created_at DESC,id DESC LIMIT 1`)[0].status, "deny")
        assert.equal((await lab.call(who, `/v1/permissions/sets/${set.id}/permissions`, "PUT", { changes: [{ key: "branding.update", status: "allow" }] })).status, 403, "cannot re-grant a permission the caller just relinquished")
        assert.equal((await lab.call(owner, `/v1/permissions/sets/${set.id}/permissions`, "PUT", { changes: [{ key: "branding.update", status: "allow" }] })).status, 200, "owner can restore the lab probe")
      } else if (["admin", "demoted", "teamadmin"].includes(label)) {
        assert.equal(permissions.length, 41, `${label}: unchanged Admin defaults`)
        assert.equal((await lab.call(who, `/v1/teams/${team.id}`, "PATCH", { memberIds: [...roster, cohort.ids[label]] })).status, 403, `${label} cannot enroll themselves in the preserved team`)
        for (const key of preservedKeys) assert.equal(permissions.includes(key), false, `${label}: no preserved grant`)
        assert.equal((await lab.call(who, `/v1/members/${cohort.ids.member}/role`, "POST", { role: "admin" })).status, 403)
        assert.equal((await lab.call(who, `/v1/permissions/sets/${set.id}/permissions`, "PUT", { changes: [{ key: "members.update", status: "allow" }] })).status, 403)
      } else if (["member", "wrongcase", "substring"].includes(label)) assert.equal(permissions.length, 0, label)
      else assert.equal(permissions.length, 57, `${label}: owner keeps all released capabilities`)
    }
    currentTestEvidence()?.recordAssertionEvidence("Preserved people can really manage member roles and permissions; other people gain nothing", `${version}: each selected person has 55 keys and writes roles/permission history; ordinary Admin/demoted/Admin-team-only controls stay at 41, members/case controls at 0, owners at 57. Outside admins cannot write roles, permissions or enroll themselves. Agent/deployment keys absent.`, true)
    if (process.env.EXP_O2_SCREENSHOTS === "1") {
      const { capturePreservedTeam } = await import("../support/den-super-admin-upgrade-shots.ts")
      await capturePreservedTeam(lab, team.id, set.id)
    }
    const stable = lab.preservationState()
    lab.branchMigrate()
    assert.deepEqual(lab.preservationState(), stable, "bootstrap rerun is idempotent")
    lab.replay0138()
    assert.deepEqual(lab.preservationState(), stable, "exact SQL replay is idempotent")

    const promoted = await lab.login(cohort.identities.promoted.email)
    assert.equal((await lab.call(owner, `/v1/teams/${team.id}`, "PATCH", { name: team.name, memberIds: expected.filter(label => label !== "promoted").map(label => cohort.ids[label]), grantsOrganizationAdmin: false })).status, 200)
    assert.equal(field((await lab.call(promoted, "/v1/org")).data, "currentMember", "permissions") instanceof Array, true)
    assert.equal((await lab.call(promoted, `/v1/members/${cohort.ids.member}/role`, "POST", { role: "admin" })).status, 403, "member removal revokes access without a restart")
    const removed = lab.preservationState()
    lab.replay0138()
    lab.branchMigrate()
    assert.deepEqual(lab.preservationState(), removed, "removed membership is not re-enrolled")
    assert.ok([200, 204].includes((await lab.call(owner, `/v1/permissions/sets/${set.id}`, "DELETE")).status))
    const archived = lab.preservationState()
    const invited = await lab.login(cohort.identities.invited.email)
    assert.equal((await lab.call(invited, `/v1/members/${cohort.ids.member}/role`, "POST", { role: "admin" })).status, 403, "set deletion immediately revokes remaining people")
    lab.replay0138()
    lab.branchMigrate()
    assert.deepEqual(lab.preservationState(), archived, "deleted set is never recreated")
    currentTestEvidence()?.recordAssertionEvidence("Replay cannot undo owner revocation", "Bootstrap and exact SQL replay leave all five storage tables byte-for-byte unchanged; owner membership removal and set deletion revoke on the next API request without restart, and repeated bootstrap/SQL never restore either grant", true)

    // Independently restore the same API-built .57 data, take the already-.59
    // path, then apply the branch. Original 0138 hash must be accepted, not rerun.
    lab.stopApi()
    lab.restore(before)
    lab.publishedMigrate(images.after)
    const already = lab.preservationState()
    lab.branchMigrate()
    assert.deepEqual(lab.preservationState(), already, "already-deprecated data gets zero preservation changes")
    assert.equal(lab.rows("SELECT * FROM team WHERE name LIKE 'Super Admins (%)'").length, 0)
    currentTestEvidence()?.recordAssertionEvidence("Already-0.18.59 databases are not repaired or changed by preservation", "Restored API-built 0.18.57 cohort; released 0.18.59 bootstrap first; then branch bootstrap accepts the original hash and leaves all five team/permission storage tables identical, with no preservation team", true)

    // Fresh bootstrap stamps migration receipts from the snapshot; it must not
    // manufacture legacy people, teams or grants.
    lab.restore("")
    lab.branchMigrate()
    for (const table of ["team", "team_member", "permission_set", "permission_set_permission", "permission_set_team"])
      assert.equal(lab.rows(`SELECT * FROM ${table}`).length, 0, `fresh ${table}`)
    const fresh = lab.preservationState()
    lab.branchMigrate()
    assert.deepEqual(lab.preservationState(), fresh)
    currentTestEvidence()?.recordAssertionEvidence("Fresh install and rerun create no preservation state", "Built branch snapshot bootstrap on an empty database leaves all five team/permission tables empty and a second startup identical", true)
    console.log(`${engine}: exact active cohort + 14 grants + released API 55/41/0/57 access; real role/permission APIs; owner revocation; already-deprecated/fresh/replay checks passed`)
  } finally {
    await lab.close()
    currentTestEvidence()?.recordAssertionEvidence("Owned lab resources are gone", `${engine}: database dropped, exp-o2 containers and named volumes absent, SSH child exited and all six VM ports closed`, true)
  }
})
