import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm"
import { parseFeatureEnvironment, type FeatureEnvironment } from "@openwork/features"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { INFERENCE_USAGE_CONVERSION_FACTOR } from "@openwork/types/den/inference"
import type { OrganizationBenefit } from "@openwork/types/den/organization-grants"
import { readFeatures, type FeatureDatabase } from "./organization-features"
import { OrganizationTable } from "./schema/org"
import { OrganizationBenefitSettingTable, OrganizationGrantTable, OrganizationGrantUsageTable } from "./schema/organization-grants"

export type BenefitGrant = typeof OrganizationGrantTable.$inferSelect
export type OrganizationBenefits = {
  enabled: boolean; now: Date;
  settings: Record<OrganizationBenefit, "default" | "enabled" | "disabled">;
  grants: BenefitGrant[];
}

export async function readOrganizationBenefits(database: FeatureDatabase, organizationId: string, environment: FeatureEnvironment = parseFeatureEnvironment(process.env), knownEnabled?: boolean): Promise<OrganizationBenefits> {
  const id = normalizeDenTypeId("organization", organizationId)
  const enabled = knownEnabled ?? (await readFeatures(database, id, environment)).organizationGrants
  const result: OrganizationBenefits = { enabled, now: new Date(), settings: { freeAuto: "default", openworkWeb: "default" }, grants: [] }
  // Reverting the rollout neither drops stored grants nor depends on the new tables being present.
  if (!enabled) return result
  const [clock] = await database.select({ now: sql<number>`unix_timestamp(current_timestamp(3)) * 1000` }).from(OrganizationTable).where(eq(OrganizationTable.id, id)).limit(1)
  if (!clock) throw new Error("organization_not_found")
  result.now = new Date(Number(clock.now))
  const settings = await database.select().from(OrganizationBenefitSettingTable).where(eq(OrganizationBenefitSettingTable.organizationId, id))
  for (const row of settings) result.settings[row.feature] = row.setting
  result.grants = await database.select().from(OrganizationGrantTable).where(and(
    eq(OrganizationGrantTable.organizationId, id), isNull(OrganizationGrantTable.revokedAt),
    lte(OrganizationGrantTable.startsAt, result.now), or(isNull(OrganizationGrantTable.expiresAt), gt(OrganizationGrantTable.expiresAt, result.now)),
    or(isNull(OrganizationGrantTable.amount), sql`${OrganizationGrantTable.usedAmount} < ${OrganizationGrantTable.amount}`),
  )).orderBy(sql`${OrganizationGrantTable.expiresAt} is null`, asc(OrganizationGrantTable.expiresAt), asc(OrganizationGrantTable.id))
  return result
}

export function benefitAccess(benefits: OrganizationBenefits, feature: OrganizationBenefit, normalAccess: boolean) {
  if (benefits.settings[feature] === "disabled") return false
  return benefits.settings[feature] === "enabled" || normalAccess || benefits.grants.some(grant => grant.feature === feature)
}

export function freeAutoGrantAllowance(benefits: OrganizationBenefits) {
  const grants = benefits.grants.filter(grant => grant.feature === "freeAuto")
  return {
    unlimited: grants.some(grant => grant.kind === "unlimited"),
    totalAmount: grants.reduce((sum, grant) => sum + (grant.kind === "usage" ? grant.amount ?? 0 : 0), 0),
    usedAmount: grants.reduce((sum, grant) => sum + (grant.kind === "usage" ? grant.usedAmount : 0), 0),
    remainingAmount: grants.reduce((sum, grant) => sum + (grant.kind === "usage" && grant.amount !== null ? Math.max(0, grant.amount - grant.usedAmount) : 0), 0),
    grantIds: grants.filter(grant => grant.kind === "usage").map(grant => grant.id),
  }
}

export type FreeAutoGrantAdmission = { grantIds: BenefitGrant["id"][]; unlimited: boolean }

/**
 * Uses the grants captured at admission, so a response can finish after expiry or revocation. Caller holds the
 * organization lock and commits this with its idempotent Free Auto receipt. Like the existing weekly allowance,
 * admission checks recorded spend; in-flight responses may finish over the ceiling, and every unit is recorded.
 */
export async function chargeFreeAutoGrants(database: FeatureDatabase, input: { organizationId: string; requestId: string; admission: FreeAutoGrantAdmission; amount: number }) {
  if (input.amount <= 0 || input.admission.unlimited || input.admission.grantIds.length === 0) return
  const grants = await database.select().from(OrganizationGrantTable).where(and(
    eq(OrganizationGrantTable.organizationId, normalizeDenTypeId("organization", input.organizationId)),
    inArray(OrganizationGrantTable.id, input.admission.grantIds), eq(OrganizationGrantTable.feature, "freeAuto"), eq(OrganizationGrantTable.kind, "usage"),
  )).orderBy(sql`${OrganizationGrantTable.expiresAt} is null`, asc(OrganizationGrantTable.expiresAt), asc(OrganizationGrantTable.id)).for("update")
  let remaining = input.amount
  for (const [index, grant] of grants.entries()) {
    const amount = index === grants.length - 1 ? remaining : Math.min(remaining, Math.max(0, (grant.amount ?? 0) - grant.usedAmount))
    if (amount <= 0) continue
    await database.insert(OrganizationGrantUsageTable).values({ grantId: grant.id, requestId: input.requestId, amount })
    await database.update(OrganizationGrantTable).set({ usedAmount: sql`${OrganizationGrantTable.usedAmount} + ${amount}` }).where(eq(OrganizationGrantTable.id, grant.id))
    remaining -= amount
    if (remaining === 0) break
  }
}

export function grantUsd(amount: number) { return amount / INFERENCE_USAGE_CONVERSION_FACTOR }
