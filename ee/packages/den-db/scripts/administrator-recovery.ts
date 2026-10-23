import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import mysql from "mysql2/promise"
import { parseFeatureEnvironment, resolveFeature, type FeatureRollouts, type FeatureOverrides } from "@openwork/features"
import { parseMySqlConnectionConfig } from "../src/mysql-config.ts"

const stable = (prefix: string, value: string) => `${prefix}_0${createHash("sha256").update(`admin-recovery-0155:${value}`).digest("hex").slice(0, 25)}`

/** Deploy bootstrap only, never ordinary API startup. The stable permission set,
 * including its archived state, permanently fences a consumed organization.
 * Disabling the feature stops future repairs, not existing grants.
 */
export async function recoverAdministratorsFromEnv() {
  const environment = parseFeatureEnvironment(process.env)
  if (environment.problems.some((problem) => problem.fatal)) throw new Error("Invalid feature environment")
  const raw: unknown = JSON.parse(process.env.DEN_ADMINISTRATOR_RECOVERY_TEAMS || "{}")
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Recovery teams must be an organization-to-team-ID map")
  const teams = new Map<string, string>()
  for (const [org, team] of Object.entries(raw)) {
    if (typeof team !== "string") throw new Error("Recovery team IDs must be strings")
    teams.set(org, team)
  }
  const url = process.env.DATABASE_URL?.trim()
  if (!url) throw new Error("Deploy-time recovery requires the bootstrap TCP DATABASE_URL")
  const grants = readFileSync(new URL("./administrator-recovery.sql", import.meta.url), "utf8")
  const connection = await mysql.createConnection(parseMySqlConnectionConfig(url))
  let changed = 0
  try {
    const [organizations] = await connection.query<mysql.RowDataPacket[]>("SELECT id FROM organization ORDER BY id")
    for (const row of organizations) {
      const org: unknown = row.id
      if (typeof org !== "string") throw new Error("Invalid organization ID")
      await connection.beginTransaction()
      try {
        await connection.query("SELECT id FROM organization WHERE id=? FOR UPDATE", [org])
        // Same storage and resolver as readFeatures; no member override for an
        // organization-owned operation. Keep reads on this TCP transaction.
        const [rolloutRows] = await connection.query<mysql.RowDataPacket[]>("SELECT enabled,killed FROM feature_rollout WHERE feature_key='administratorRecovery' LOCK IN SHARE MODE")
        const [overrideRows] = await connection.query<mysql.RowDataPacket[]>("SELECT enabled FROM organization_feature WHERE organization_id=? AND feature_key='administratorRecovery' LOCK IN SHARE MODE", [org])
        const rollouts: FeatureRollouts = {}
        const overrides: FeatureOverrides = {}
        if (rolloutRows[0]) rollouts.administratorRecovery = { enabled: rolloutRows[0].enabled === 1, killed: rolloutRows[0].killed === 1 }
        if (overrideRows[0]) overrides.administratorRecovery = overrideRows[0].enabled === 1
        if (!resolveFeature("administratorRecovery", { ...environment, rollouts, overrides }).enabled) {
          await connection.rollback()
          continue
        }
        const set = stable("pms", org)
        const [fence] = await connection.query<mysql.RowDataPacket[]>("SELECT id FROM permission_set WHERE id=?", [set])
        if (fence.length) { await connection.rollback(); continue }
        const team = teams.get(org)
        if (!team) throw new Error("An enabled organization requires an explicit recovery team ID")
        const [selected] = await connection.query<mysql.RowDataPacket[]>("SELECT id FROM team WHERE id=? AND organization_id=? AND grants_organization_admin=1 FOR UPDATE", [team, org])
        if (selected.length !== 1) throw new Error("Recovery team must be an existing non-SCIM Admin team")
        const [scim] = await connection.query<mysql.RowDataPacket[]>("SELECT id FROM scim_group WHERE team_id=? UNION ALL SELECT id FROM scim_group_member WHERE team_member_id IN (SELECT id FROM team_member WHERE team_id=?) LIMIT 1", [team, team])
        if (scim.length) throw new Error("SCIM-managed recovery team is not supported")
        await connection.query("SET @den_admin_recovery_org = ?", [org])
        await connection.query("INSERT INTO permission_set(id,organization_id,default_key,name) VALUES(?,?,NULL,'Restored administrator permissions')", [set, org])
        await connection.query(grants)
        await connection.query("INSERT INTO permission_set_team(id,organization_id,permission_set_id,team_id) VALUES(?,?,?,?)", [stable("pst", org), org, set, team])
        await connection.query("UPDATE organization SET team_membership_revision=UUID() WHERE id=?", [org])
        await connection.commit()
        changed++
      } catch (error) {
        await connection.rollback()
        throw error
      } finally {
        await connection.query("SET @den_admin_recovery_org = NULL")
      }
    }
  } finally { await connection.end() }
  console.log(`[den-db] administrator recovery: ${changed} organizations consumed; origin=deploy-bootstrap, memberActor=NULL (out-of-band operator action; retain deployment change record)`)
  return changed
}
