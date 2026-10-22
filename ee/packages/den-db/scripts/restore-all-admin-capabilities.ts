/**
 * Explicit alternative to selective migration 0155. Never called by bootstrap,
 * db:migrate, reconciliation or organization creation. Dry run unless --apply.
 * Requires an operator decision: this also elevates admins who were NEVER
 * super-admins, including Admin-team members. Owners can revoke in Admin permissions.
 */
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { PermissionKey } from "@openwork/types/den/permissions"
import { createDenDb } from "../src/client.ts"
import {
  buildPermissionRows,
  ensureDefaultPermissionSets,
  getDefaultPermissionSets,
  latestPermissionRowCreatedAt,
  lockPermissionSet,
  readPermissionSetStates,
  type PermissionDatabase,
} from "../src/permissions.ts"
import { OrganizationTable, PermissionSetPermissionTable } from "../src/schema.ts"

export const FORMER_SUPER_ADMIN_KEYS = [
  "organization.update", "branding.update", "web_origins.manage", "members.update",
  "teams.manage_admin", "sso.manage", "scim.manage", "api_keys.manage",
  "desktop_policies.manage", "egress_diagnostics.manage", "billing_portal.use",
  "connections.update", "connections.delete", "permissions.manage",
] satisfies readonly PermissionKey[]

/** Each key with any history is left alone, including user denials and revocations. */
export async function restoreAllAdminCapabilities(database: PermissionDatabase, options: { apply: boolean }) {
  // Snapshot the existing organizations for this explicit invocation. Code
  // defaults are unchanged; organizations created afterwards receive no grant.
  const organizations = await database.select({ id: OrganizationTable.id }).from(OrganizationTable)
  let rowsPlanned = 0
  let rowsInserted = 0
  for (const organization of organizations) {
    const sets = options.apply
      ? await ensureDefaultPermissionSets(database, organization.id)
      : await getDefaultPermissionSets(database, organization.id)
    if (!options.apply) {
      const states = sets.admin ? (await readPermissionSetStates(database, [sets.admin.id])).get(sets.admin.id) : undefined
      rowsPlanned += FORMER_SUPER_ADMIN_KEYS.filter((key) => !states?.has(key)).length
      continue
    }
    if (!sets.admin) throw new Error("Admin default set missing after creation")
    const set = sets.admin
    const inserted = await database.transaction(async (tx) => {
      if (!(await lockPermissionSet(tx, organization.id, set.id))) throw new Error("Admin default set disappeared")
      const states = (await readPermissionSetStates(tx, [set.id], { lock: "share" })).get(set.id)
      const changes = FORMER_SUPER_ADMIN_KEYS.filter((key) => !states?.has(key)).map((key): { key: PermissionKey; status: "allow" } => ({ key, status: "allow" }))
      if (changes.length === 0) return 0
      await tx.insert(PermissionSetPermissionTable).values(buildPermissionRows({
        organizationId: organization.id,
        permissionSetId: set.id,
        changes,
        source: "migration",
        notBefore: await latestPermissionRowCreatedAt(tx, set.id),
      }))
      return changes.length
    })
    rowsPlanned += inserted
    rowsInserted += inserted
  }
  return { organizationsChecked: organizations.length, rowsPlanned, rowsInserted }
}

function operatorDatabase() {
  // Same connection choice as bootstrap/reconciliation.
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (databaseUrl) return createDenDb({ databaseUrl, mode: "mysql" })
  const host = process.env.DATABASE_HOST?.trim()
  const username = process.env.DATABASE_USERNAME?.trim()
  if (!host || !username) throw new Error("Database connection is required")
  return createDenDb({ mode: "planetscale", planetscale: { host, username, password: process.env.DATABASE_PASSWORD ?? "" } })
}

async function main() {
  const args = process.argv.slice(2)
  if (!args.includes("--all-admins") || args.some((arg) => !["--all-admins", "--apply"].includes(arg))) {
    throw new Error("Usage: restore-all-admin-capabilities.ts --all-admins [--apply]. This widens access for all existing admins; without --apply it only reports counts.")
  }
  await import("../src/load-env.ts")
  const { db, client } = operatorDatabase()
  try {
    console.log(JSON.stringify(await restoreAllAdminCapabilities(db, { apply: args.includes("--apply") })))
  } finally {
    if ("end" in client) await client.end()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Driver errors may contain connection URLs: do not print them.
    console.error("Administrator recovery failed. Check arguments, database access and the operator's private logs; no credentials are printed.")
    process.exitCode = 1
  })
}
