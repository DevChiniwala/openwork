import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { getOrganizationFeatures } from "../features.js"

/** Resolve the runner owner's member override as well as deployment safety controls. */
export async function readOrganizationEnginePolicy(organizationId: string, ownerMemberId?: string) {
  const [member] = ownerMemberId ? await db.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
    eq(MemberTable.organizationId, normalizeDenTypeId("organization", organizationId)),
    eq(MemberTable.id, normalizeDenTypeId("member", ownerMemberId)), isNull(MemberTable.removedAt),
  )).limit(1) : []
  const features = await getOrganizationFeatures(organizationId, { userId: member?.userId ?? undefined })
  return { upgrade: features.engineV2ForceUpgrade }
}
