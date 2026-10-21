import { env } from "./env.js"
import { hasOpenWorkWebComplimentaryAccess } from "./openwork-web-access.js"
import { benefitAccess } from "@openwork-ee/den-db"
import { getOrganizationBenefits } from "./organization-benefits.js"

/** Current complimentary entitlement, including expiring awards. Paid subscriptions resolve separately. */
export async function complimentaryWebAccessForOrganization(organizationId: string, metadata: Record<string, unknown> | string | null | undefined) {
  const benefits = await getOrganizationBenefits(organizationId)
  return benefitAccess(benefits, "openworkWeb", hasOpenWorkWebComplimentaryAccess(metadata))
}

export async function isOpenWorkWebAvailableWithGrants(organizationId: string, metadata: Record<string, unknown> | string | null | undefined) {
  return env.openworkWebEnabled || await complimentaryWebAccessForOrganization(organizationId, metadata)
}

export function openWorkWebDeploymentAvailable(enabled: boolean) {
  return enabled === true
}

export function isOpenWorkWebAvailable() {
  return openWorkWebDeploymentAvailable(env.openworkWebEnabled)
}

export function openWorkWebAvailableForOrganization(
  enabled: boolean,
  metadata: Record<string, unknown> | string | null | undefined,
) {
  return openWorkWebDeploymentAvailable(enabled) || hasOpenWorkWebComplimentaryAccess(metadata)
}

export function isOpenWorkWebAvailableForOrganization(
  metadata: Record<string, unknown> | string | null | undefined,
) {
  return openWorkWebAvailableForOrganization(env.openworkWebEnabled, metadata)
}
