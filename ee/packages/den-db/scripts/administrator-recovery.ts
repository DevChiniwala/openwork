import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import mysql from "mysql2/promise"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import { parseFeatureEnvironment, resolveFeature, type FeatureRollouts, type FeatureOverrides } from "@openwork/features"
import { parseMySqlConnectionConfig } from "../src/mysql-config.ts"

type Organization = { id: string; slug: string; name: string }
type Target = { organization: Organization; selector: string }
type RecoveryMode = "check" | "apply"
const stable = (prefix: string, value: string) => `${prefix}_0${createHash("sha256").update(`admin-recovery-0155:${value}`).digest("hex").slice(0, 25)}`

export function administratorRecoveryModeFromEnv(): RecoveryMode {
  const mode = process.env.DEN_ADMINISTRATOR_RECOVERY_MODE?.trim() || "apply"
  if (mode !== "check" && mode !== "apply") throw new Error("Administrator recovery mode must be check or apply")
  return mode
}

function organizationFor(organizations: Organization[], selector: string): Organization {
  const matches = organizations.filter((org) => isDenTypeId("organization", selector) ? org.id === selector : org.slug === selector)
  if (matches.length === 0) throw new Error(`Recovery organization ${JSON.stringify(selector)} was not found; use its ID or exact slug`)
  if (matches.length !== 1) throw new Error(`Recovery organization ${JSON.stringify(selector)} is ambiguous; use its ID`)
  const organization = matches[0]
  if (!organization) throw new Error("Recovery organization was not found")
  return organization
}

function targetsFromEnv(organizations: Organization[]): Target[] {
  const raw: unknown = JSON.parse(process.env.DEN_ADMINISTRATOR_RECOVERY_TEAMS || "{}")
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Recovery teams must be an organization-to-team map")
  const entries = Object.entries(raw)
  const team = process.env.DEN_ADMINISTRATOR_RECOVERY_TEAM?.trim()
  const selector = process.env.DEN_ADMINISTRATOR_RECOVERY_ORGANIZATION?.trim()
  if (entries.length && (team || selector)) throw new Error("Use recovery team/organization or the teams map, not both")
  const targets: Target[] = []
  if (entries.length) {
    for (const [org, value] of entries) {
      if (typeof value !== "string" || !value.trim()) throw new Error("Recovery team IDs or names must be non-empty strings")
      targets.push({ organization: organizationFor(organizations, org), selector: value.trim() })
    }
  } else {
    if (!team) throw new Error("An enabled recovery requires an explicit team ID or name")
    let organization: Organization | undefined
    if (selector) organization = organizationFor(organizations, selector)
    else {
      if (organizations.length !== 1) throw new Error("Recovery organization is required when the database does not contain exactly one organization; set its ID or slug")
      organization = organizations[0]
    }
    if (!organization) throw new Error("Recovery organization was not found")
    targets.push({ organization, selector: team })
  }
  if (new Set(targets.map((target) => target.organization.id)).size !== targets.length) throw new Error("Recovery organization selected more than once; use one ID or slug per organization")
  return targets
}

async function featureEnabled(connection: mysql.Connection, organizationId: string, environment: ReturnType<typeof parseFeatureEnvironment>, lock: boolean) {
  const suffix = lock ? " LOCK IN SHARE MODE" : ""
  const [rolloutRows] = await connection.query<mysql.RowDataPacket[]>("SELECT enabled,killed FROM feature_rollout WHERE feature_key='administratorRecovery'" + suffix)
  const [overrideRows] = await connection.query<mysql.RowDataPacket[]>("SELECT enabled FROM organization_feature WHERE organization_id=? AND feature_key='administratorRecovery'" + suffix, [organizationId])
  const rollouts: FeatureRollouts = {}
  const overrides: FeatureOverrides = {}
  if (rolloutRows[0]) rollouts.administratorRecovery = { enabled: rolloutRows[0].enabled === 1, killed: rolloutRows[0].killed === 1 }
  if (overrideRows[0]) overrides.administratorRecovery = overrideRows[0].enabled === 1
  return resolveFeature("administratorRecovery", { ...environment, rollouts, overrides }).enabled
}

async function resolveTeam(connection: mysql.Connection, target: Target, lock: boolean) {
  const byId = isDenTypeId("team", target.selector)
  const statement = byId
    ? "SELECT id,name,grants_organization_admin FROM team WHERE organization_id=? AND id=?"
    : "SELECT id,name,grants_organization_admin FROM team WHERE organization_id=? AND name=?"
  const [rows] = await connection.query<mysql.RowDataPacket[]>(statement + (lock ? " FOR UPDATE" : ""), [target.organization.id, target.selector])
  if (rows.length === 0) throw new Error(`No recovery team ${JSON.stringify(target.selector)} in organization ${JSON.stringify(target.organization.slug)}`)
  if (rows.length !== 1) throw new Error(`Recovery team name ${JSON.stringify(target.selector)} is ambiguous in this organization; use a team ID`)
  const row = rows[0]
  if (!row || typeof row.id !== "string" || typeof row.name !== "string") throw new Error("Invalid recovery team record")
  if (row.grants_organization_admin !== 1) throw new Error("Recovery target must be a designated Admin team, not an ordinary team")
  const [scim] = await connection.query<mysql.RowDataPacket[]>("SELECT id FROM scim_group WHERE team_id=? UNION ALL SELECT id FROM scim_group_member WHERE team_member_id IN (SELECT id FROM team_member WHERE team_id=?) LIMIT 1", [row.id, row.id])
  if (scim.length) throw new Error("SCIM-managed recovery team is not supported")
  return { id: row.id, name: row.name }
}

async function printCheck(connection: mysql.Connection, target: Target, enabled: boolean) {
  const team = await resolveTeam(connection, target, false)
  const [fence] = await connection.query<mysql.RowDataPacket[]>("SELECT archived_at FROM permission_set WHERE id=?", [stable("pms", target.organization.id)])
  const [people] = await connection.query<mysql.RowDataPacket[]>(
    "SELECT DISTINCT m.id,m.role,m.user_id,m.is_setup_agent,u.name,COALESCE(u.email,i.email) AS email FROM team_member tm JOIN member m ON m.id=tm.org_membership_id AND m.organization_id=? LEFT JOIN user u ON u.id=m.user_id LEFT JOIN invitation i ON i.id=m.invite_id AND i.organization_id=m.organization_id WHERE tm.team_id=? AND m.removed_at IS NULL ORDER BY m.id",
    [target.organization.id, team.id],
  )
  const [roles] = await connection.query<mysql.RowDataPacket[]>("SELECT p.id,p.name FROM permission_set_team l JOIN permission_set p ON p.id=l.permission_set_id AND p.organization_id=l.organization_id WHERE l.organization_id=? AND l.team_id=? AND l.removed_at IS NULL AND p.archived_at IS NULL ORDER BY p.id", [target.organization.id, team.id])
  const action = fence.length ? "already_consumed_no_recreation" : enabled ? "would_apply" : "enable_feature_before_apply"
  // JSON escapes untrusted names/newlines. Never include credentials or tokens.
  console.log(JSON.stringify({ event: "administrator_recovery_check", organization: target.organization, team, existingRoles: roles.map((role) => ({ id: role.id, name: role.name })), featureEnabled: enabled, action, recoveryPermissionCount: 14, peopleCount: people.length, note: "Existing Admin default decisions remain in force; owners already have all permissions. This is not a roster fingerprint." }))
  for (const person of people) console.log(JSON.stringify({ event: "administrator_recovery_recipient", memberId: person.id, name: person.name, email: person.email, role: person.role, connected: person.user_id !== null, setupAgent: person.is_setup_agent === 1, ownerUnchanged: person.role === "owner" }))
}

/** Deploy bootstrap only. Check uses a read-only transaction, even with the flag
 * off. Apply requires the feature and permanently respects the set's fence,
 * including its archived state. No roster is selected from historical evidence.
 */
export async function recoverAdministratorsFromEnv() {
  const environment = parseFeatureEnvironment(process.env)
  if (environment.problems.some((problem) => problem.fatal)) throw new Error("Invalid feature environment")
  const mode = administratorRecoveryModeFromEnv()
  const url = process.env.DATABASE_URL?.trim()
  if (!url) throw new Error("Deploy-time recovery requires the bootstrap TCP DATABASE_URL")
  const connection = await mysql.createConnection(parseMySqlConnectionConfig(url))
  let changed = 0
  try {
    if (mode === "check") await connection.query("START TRANSACTION READ ONLY")
    const [rows] = await connection.query<mysql.RowDataPacket[]>("SELECT id,slug,name FROM organization ORDER BY id")
    const organizations: Organization[] = rows.map((row) => {
      if (typeof row.id !== "string" || typeof row.slug !== "string" || typeof row.name !== "string") throw new Error("Invalid recovery organization record")
      return { id: row.id, slug: row.slug, name: row.name }
    })
    if (mode === "apply") {
      let enabled = false
      for (const org of organizations) if (await featureEnabled(connection, org.id, environment, false)) enabled = true
      if (!enabled) return 0
    }
    const targets = targetsFromEnv(organizations)
    if (mode === "check") {
      for (const target of targets) await printCheck(connection, target, await featureEnabled(connection, target.organization.id, environment, false))
      console.log("[den-db] administrator recovery check complete; no database changes")
      return 0
    }
    const grants = readFileSync(new URL("./administrator-recovery.sql", import.meta.url), "utf8")
    for (const target of targets) {
      const org = target.organization.id
      await connection.beginTransaction()
      try {
        await connection.query("SELECT id FROM organization WHERE id=? FOR UPDATE", [org])
        if (!await featureEnabled(connection, org, environment, true)) { await connection.rollback(); continue }
        const team = await resolveTeam(connection, target, true)
        const set = stable("pms", org)
        const [fence] = await connection.query<mysql.RowDataPacket[]>("SELECT id FROM permission_set WHERE id=?", [set])
        if (fence.length) { await connection.rollback(); continue }
        await connection.query("SET @den_admin_recovery_org = ?", [org])
        await connection.query("INSERT INTO permission_set(id,organization_id,default_key,name) VALUES(?,?,NULL,'Restored administrator permissions')", [set, org])
        await connection.query(grants)
        await connection.query("INSERT INTO permission_set_team(id,organization_id,permission_set_id,team_id) VALUES(?,?,?,?)", [stable("pst", org), org, set, team.id])
        await connection.query("UPDATE organization SET team_membership_revision=UUID() WHERE id=?", [org])
        await connection.commit()
        changed++
      } catch (error) { await connection.rollback(); throw error }
      finally { await connection.query("SET @den_admin_recovery_org = NULL") }
    }
  } finally {
    if (mode === "check") await connection.rollback()
    await connection.end()
  }
  console.log(`[den-db] administrator recovery: ${changed} organizations consumed; origin=deploy-bootstrap, memberActor=NULL (out-of-band operator action; retain deployment change record)`)
  return changed
}
