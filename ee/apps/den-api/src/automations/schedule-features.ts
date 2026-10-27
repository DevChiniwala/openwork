import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { AutomationSchedule } from "@openwork/types/automations"
import { db } from "../db.js"
import { organizationFeatureEnabled } from "../features.js"

/**
 * Whether the owner of an Automation may use interval schedules: their
 * organization's setting, with an override for them as a member. The
 * scheduler has no request, so it resolves the owner's user itself.
 */
export async function ownerIntervalSchedulesEnabled(input: { organizationId: string; ownerMemberId: string }): Promise<boolean> {
  const [member] = await db.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
    eq(MemberTable.id, normalizeDenTypeId("member", input.ownerMemberId)),
    eq(MemberTable.organizationId, normalizeDenTypeId("organization", input.organizationId)),
    isNull(MemberTable.removedAt),
  )).limit(1)
  return organizationFeatureEnabled(input.organizationId, "automationIntervalSchedules", member?.userId ? { userId: member.userId } : {})
}

/**
 * Whether a requested schedule only repeats the interval the Automation
 * already has. Editors send the whole definition on every save, so an
 * Automation created while the feature was on can still be renamed or
 * re-instructed after it is turned off.
 */
export function keepsCurrentInterval(requested: AutomationSchedule, current: AutomationSchedule): boolean {
  return requested.kind === "interval" && current.kind === "interval"
    && requested.timezone === current.timezone
    && requested.everyHours === current.everyHours
    && requested.startHour === current.startHour
    && requested.endHour === current.endHour
    && requested.daysOfWeek.join(",") === current.daysOfWeek.join(",")
}
