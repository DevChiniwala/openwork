import { FREE_ORG_SEAT_COUNT } from "./billing-quantities.js"
import { parseEnterpriseTrial, parseOrganizationPlan, type EnterpriseTrial } from "./entitlements.js"

/**
 * Pure rules for Enterprise trials: how starting and ending one changes
 * `organization.metadata`. No I/O, so every transition is unit tested.
 *
 * During a trial the organization is Enterprise in the product, and its users
 * (members plus pending invitations) are limited to the trial's seats: the
 * Free plan user limit becomes the trial's seats. When the trial ends, the
 * plan returns to Free (Stripe then restores a paid plan, if any) and the
 * Free plan user limit goes back to what it was before.
 */

export const ENTERPRISE_TRIAL_MIN_SEATS = FREE_ORG_SEAT_COUNT
export const ENTERPRISE_TRIAL_MAX_SEATS = 100_000
/** A trial may run for at most a year from the day it is started or changed. */
export const ENTERPRISE_TRIAL_MAX_DAYS = 366

type Metadata = Record<string, unknown>

export type EnterpriseTrialEndReason = "expired" | "ended_by_admin"

export type StartEnterpriseTrialError =
  | "seats_invalid"
  | "ends_at_invalid"
  | "ends_at_in_past"
  | "ends_at_too_far"
  | "paid_enterprise_plan"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0
}

export function validateEnterpriseTrialInput(input: { seats: number; endsAt: Date; now: Date }): StartEnterpriseTrialError | null {
  // The Free plan already includes FREE_ORG_SEAT_COUNT users; a trial never lowers that.
  if (!Number.isInteger(input.seats) || input.seats < ENTERPRISE_TRIAL_MIN_SEATS || input.seats > ENTERPRISE_TRIAL_MAX_SEATS) return "seats_invalid"
  const endsAt = input.endsAt.getTime()
  if (!Number.isFinite(endsAt)) return "ends_at_invalid"
  if (endsAt <= input.now.getTime()) return "ends_at_in_past"
  if (endsAt - input.now.getTime() > ENTERPRISE_TRIAL_MAX_DAYS * 86_400_000) return "ends_at_too_far"
  return null
}

/**
 * Metadata after starting (or changing) an Enterprise trial. Changing a
 * running trial keeps its start and the values to restore. A Stripe-billed
 * Enterprise plan is refused: it is already the real thing.
 */
export function metadataWithEnterpriseTrial(
  current: Metadata,
  input: { seats: number; endsAt: Date; now: Date; startedByUserId: string | null },
): { ok: true; metadata: Metadata; trial: EnterpriseTrial } | { ok: false; error: StartEnterpriseTrialError } {
  const invalid = validateEnterpriseTrialInput(input)
  if (invalid) return { ok: false, error: invalid }
  const plan = parseOrganizationPlan(current, input.now)
  if (plan.tier === "enterprise" && plan.source === "stripe") return { ok: false, error: "paid_enterprise_plan" }

  const running = plan.source === "trial" ? plan.trial : undefined
  const limits = isRecord(current.limits) ? current.limits : {}
  const trial: EnterpriseTrial & { previousSeatLimit: number | null } = {
    seats: input.seats,
    startedAt: running?.startedAt ?? input.now.toISOString(),
    endsAt: input.endsAt.toISOString(),
    previousSeatsFreeAdditional: running ? running.previousSeatsFreeAdditional : nonNegativeInteger(current.seatsFreeAdditional),
    startedByUserId: input.startedByUserId,
    previousSeatLimit: running ? previousSeatLimit(current) : typeof limits.members === "number" ? limits.members : null,
  }
  return {
    ok: true,
    trial,
    metadata: {
      ...current,
      plan: { tier: "enterprise", source: "trial", trial },
      // The trial's seats are the Free plan user limit (5 included plus the rest).
      seatsFreeAdditional: Math.max(0, input.seats - FREE_ORG_SEAT_COUNT),
      limits: { ...limits, members: input.seats },
    },
  }
}

function previousSeatLimit(current: Metadata): number | null {
  const plan = isRecord(current.plan) ? current.plan : {}
  const trial = isRecord(plan.trial) ? plan.trial : {}
  return typeof trial.previousSeatLimit === "number" ? trial.previousSeatLimit : null
}

/**
 * Metadata after an Enterprise trial ends (it expired, or a platform admin
 * ended it): the plan returns to Free and the Free plan user limit to what it
 * was before. The trial is kept as `plan.lastTrial` so admins can see it. Null
 * when no trial is recorded.
 */
export function metadataWithoutEnterpriseTrial(
  current: Metadata,
  input: { endedAt: Date; reason: EnterpriseTrialEndReason },
): Metadata | null {
  const storedPlan = isRecord(current.plan) ? current.plan : {}
  if (storedPlan.source !== "trial") return null
  const trial = parseEnterpriseTrial(storedPlan.trial)
  const limits = isRecord(current.limits) ? { ...current.limits } : {}
  const seatLimit = previousSeatLimit(current)
  if (seatLimit === null) delete limits.members
  else limits.members = seatLimit

  const next: Metadata = {
    ...current,
    plan: {
      tier: "free",
      source: "default",
      ...(trial ? { lastTrial: { seats: trial.seats, startedAt: trial.startedAt, endsAt: trial.endsAt, endedAt: input.endedAt.toISOString(), reason: input.reason } } : {}),
    },
    limits,
  }
  const previousFree = trial?.previousSeatsFreeAdditional ?? 0
  if (previousFree > 0) next.seatsFreeAdditional = previousFree
  else delete next.seatsFreeAdditional
  return next
}
