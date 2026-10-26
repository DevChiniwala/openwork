import { sql } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"
import { parseOrganizationPlan } from "./entitlements.js"
import {
  ENTERPRISE_TRIAL_MIN_SEATS,
  metadataWithEnterpriseTrial,
  metadataWithoutEnterpriseTrial,
  type EnterpriseTrialEndReason,
  type StartEnterpriseTrialError,
} from "./enterprise-trial-rules.js"
import { updateOrganizationMetadata } from "./organization-metadata.js"
import { appLogger } from "./observability/logger.js"
import { captureException } from "./observability/runtime.js"
import { syncOrganizationBillingQuantities, syncOrganizationPlanFromSubscriptions } from "./stripe-billing.js"

type OrgId = typeof OrganizationTable.$inferSelect.id

const logger = appLogger.child({ component: "enterprise_trial" })

export class EnterpriseTrialError extends Error {
  constructor(readonly code: StartEnterpriseTrialError | "trial_missing", message: string) {
    super(message)
    this.name = "EnterpriseTrialError"
  }
}

const START_ERROR_MESSAGES: Record<StartEnterpriseTrialError, string> = {
  seats_invalid: `Seats must be a whole number of at least ${ENTERPRISE_TRIAL_MIN_SEATS}, the users the Free plan already includes.`,
  ends_at_invalid: "The end date is not a valid date.",
  ends_at_in_past: "The end date must be in the future.",
  ends_at_too_far: "A trial can run for at most a year.",
  paid_enterprise_plan: "This organization already pays for Enterprise through Stripe.",
}

/**
 * Starts an Enterprise trial, or changes the seats or end date of the one
 * running. The organization is Enterprise in the product until `endsAt`, and
 * its users are limited to `seats`.
 */
export async function startEnterpriseTrial(input: { organizationId: OrgId; seats: number; endsAt: Date; startedByUserId: string }) {
  const outcome: { error: StartEnterpriseTrialError | null } = { error: null }
  const metadata = await updateOrganizationMetadata(input.organizationId, (current) => {
    const result = metadataWithEnterpriseTrial(current, { seats: input.seats, endsAt: input.endsAt, now: new Date(), startedByUserId: input.startedByUserId })
    if (!result.ok) {
      outcome.error = result.error
      return current
    }
    return result.metadata
  })
  if (outcome.error) throw new EnterpriseTrialError(outcome.error, START_ERROR_MESSAGES[outcome.error])
  return parseOrganizationPlan(metadata)
}

/**
 * Ends an Enterprise trial: the plan returns to Free and the Free plan user
 * limit to what it was, then any paid Stripe plan is applied again.
 */
export async function endEnterpriseTrial(input: { organizationId: OrgId; reason: EnterpriseTrialEndReason; now?: Date }) {
  const outcome = { ended: false }
  const metadata = await updateOrganizationMetadata(input.organizationId, (current) => {
    const next = metadataWithoutEnterpriseTrial(current, { endedAt: input.now ?? new Date(), reason: input.reason })
    if (!next) return current
    outcome.ended = true
    return next
  })
  if (!outcome.ended) throw new EnterpriseTrialError("trial_missing", "This organization has no Enterprise trial.")
  await syncOrganizationPlanFromSubscriptions(input.organizationId)
  await syncOrganizationBillingQuantities({ organizationId: input.organizationId }).catch((error) => {
    logger.warn("failed to sync billing quantities after an Enterprise trial ended", { organization_id: input.organizationId, error })
  })
  return parseOrganizationPlan(metadata)
}

/** Organizations whose Enterprise trial has passed its end date. */
async function listExpiredEnterpriseTrials(now: Date): Promise<OrgId[]> {
  const rows = await db
    .select({ id: OrganizationTable.id, metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(sql`JSON_UNQUOTE(JSON_EXTRACT(${OrganizationTable.metadata}, '$.plan.source')) = 'trial'`)
  return rows.filter((row) => parseOrganizationPlan(row.metadata, now).trialExpired === true).map((row) => row.id)
}

/**
 * Closes every Enterprise trial past its end date. The plan already reads as
 * Free from the end date on; closing it restores the Free plan user limit and
 * any paid plan, and records the trial for admins.
 */
export async function endExpiredEnterpriseTrialsOnce(now = new Date()) {
  const organizationIds = await listExpiredEnterpriseTrials(now)
  let failures = 0
  for (const organizationId of organizationIds) {
    try {
      await endEnterpriseTrial({ organizationId, reason: "expired", now })
    } catch (error) {
      if (error instanceof EnterpriseTrialError && error.code === "trial_missing") continue
      failures += 1
      logger.warn("failed to end an expired Enterprise trial", { organization_id: organizationId, error })
    }
  }
  return { organizations: organizationIds.length, failures }
}

const ENTERPRISE_TRIAL_EXPIRY_INTERVAL_MS = 15 * 60 * 1000
let running: Promise<void> | null = null

export function startEnterpriseTrialExpiryLoop(intervalMs = ENTERPRISE_TRIAL_EXPIRY_INTERVAL_MS) {
  const run = () => {
    if (running) return
    running = endExpiredEnterpriseTrialsOnce()
      .then(() => undefined)
      .catch((error) => {
        logger.error("Enterprise trial expiry failed", { error })
        captureException(error, { component: "enterprise_trial_expiry" })
      })
      .finally(() => {
        running = null
      })
  }
  const timer = setInterval(run, intervalMs)
  timer.unref()
  run()
  return async () => {
    clearInterval(timer)
    await running
  }
}
