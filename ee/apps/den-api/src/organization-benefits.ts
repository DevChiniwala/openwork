import { readOrganizationBenefits } from "@openwork-ee/den-db"
import { db } from "./db.js"
import { env } from "./env.js"
import { organizationFeatureEnabled } from "./features.js"

/** Reuse Den's invalidated feature cache; benefit amounts and deadlines are always read from the database. */
export async function getOrganizationBenefits(organizationId: string) {
  return readOrganizationBenefits(db, organizationId, env.features, await organizationFeatureEnabled(organizationId, "organizationGrants"))
}
