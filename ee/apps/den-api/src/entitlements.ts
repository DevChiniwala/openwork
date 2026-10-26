import type { AuditEntitlement } from "@openwork/types/den/audit"
import { env } from "./env.js"

export const PLAN_TIERS = ["free", "team", "enterprise"] as const
export type PlanTier = (typeof PLAN_TIERS)[number]

/**
 * Where an organization's plan comes from. `trial` is an Enterprise trial a
 * platform admin started: Enterprise in the product, limited to `trial.seats`
 * users, until `trial.endsAt`.
 */
export const PLAN_SOURCES = ["default", "stripe", "manual", "grandfathered", "trial"] as const
export type PlanSource = (typeof PLAN_SOURCES)[number]

/** Stored at `metadata.plan.trial` while an Enterprise trial runs. */
export type EnterpriseTrial = {
  /** Users allowed during the trial (members plus pending invitations); also the Free plan user limit. */
  seats: number
  startedAt: string
  endsAt: string
  /** `seatsFreeAdditional` before the trial, restored when it ends. */
  previousSeatsFreeAdditional: number
  startedByUserId: string | null
}

export type OrganizationPlan = {
  tier: PlanTier
  source: PlanSource
  grandfatheredAt?: string
  trial?: EnterpriseTrial
  /** The trial has passed its end date; the plan reads as Free until it is closed. */
  trialExpired?: boolean
}

export const ENTITLEMENT_KEYS = ["sso", "desktopPolicies", "orgControls", "analytics", "auditLogs", "scim"] as const
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number]

export type OrganizationEntitlements = Record<EntitlementKey, boolean>

export type EnterprisePlanRequiredError = {
  error: "enterprise_plan_required"
  feature: EntitlementKey
  message: string
}

const ENTITLEMENT_FEATURE_LABELS: Record<EntitlementKey, string> = {
  sso: "SSO / SAML",
  desktopPolicies: "Desktop policies",
  orgControls: "Enforced SSO and desktop version controls",
  analytics: "Usage analytics",
  auditLogs: "Audit logs",
  scim: "SCIM provisioning",
}

type MetadataInput = Record<string, unknown> | string | null | undefined

type EntitlementOptions = {
  gatingEnabled?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseMetadata(input: MetadataInput): Record<string, unknown> {
  if (!input) {
    return {}
  }

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return isRecord(input) ? input : {}
}

function isPlanTier(value: unknown): value is PlanTier {
  return typeof value === "string" && (PLAN_TIERS as readonly string[]).includes(value)
}

function isPlanSource(value: unknown): value is PlanSource {
  return typeof value === "string" && (PLAN_SOURCES as readonly string[]).includes(value)
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null
}

export function parseEnterpriseTrial(value: unknown): EnterpriseTrial | null {
  if (!isRecord(value)) return null
  const seats = nonNegativeInteger(value.seats)
  const startedAt = typeof value.startedAt === "string" ? value.startedAt : null
  const endsAt = typeof value.endsAt === "string" && Number.isFinite(Date.parse(value.endsAt)) ? value.endsAt : null
  if (seats === null || seats < 1 || !startedAt || !endsAt) return null
  return {
    seats,
    startedAt,
    endsAt,
    previousSeatsFreeAdditional: nonNegativeInteger(value.previousSeatsFreeAdditional) ?? 0,
    startedByUserId: typeof value.startedByUserId === "string" ? value.startedByUserId : null,
  }
}

/**
 * The organization's plan as it applies now. An Enterprise trial is
 * Enterprise until its end date; after it (or when its record is unreadable)
 * the plan reads as Free, so nothing stays unlocked if the job that closes
 * trials has not run yet.
 */
export function parseOrganizationPlan(metadata: MetadataInput, now: Date = new Date()): OrganizationPlan {
  const parsed = parseMetadata(metadata)
  const plan = isRecord(parsed.plan) ? parsed.plan : {}
  const source = isPlanSource(plan.source) ? plan.source : "default"

  if (source === "trial") {
    const trial = parseEnterpriseTrial(plan.trial)
    if (!trial) return { tier: "free", source: "default", trialExpired: true }
    if (Date.parse(trial.endsAt) <= now.getTime()) return { tier: "free", source: "default", trial, trialExpired: true }
    return { tier: "enterprise", source: "trial", trial }
  }

  return {
    tier: isPlanTier(plan.tier) ? plan.tier : "free",
    source,
    ...(typeof plan.grandfatheredAt === "string" ? { grandfatheredAt: plan.grandfatheredAt } : {}),
  }
}

/** The plan as organization members see it: no trial bookkeeping. */
export function publicOrganizationPlan(plan: OrganizationPlan) {
  return {
    tier: plan.tier,
    source: plan.source,
    ...(plan.grandfatheredAt ? { grandfatheredAt: plan.grandfatheredAt } : {}),
    ...(plan.source === "trial" && plan.trial ? { trial: { seats: plan.trial.seats, endsAt: plan.trial.endsAt } } : {}),
  }
}

/**
 * Whether the plan itself lifts the Free plan user limit. Enterprise does,
 * except an Enterprise trial, which is held to the users it was started with.
 */
export function planLiftsUserLimit(plan: OrganizationPlan) {
  return plan.tier === "enterprise" && plan.source !== "trial"
}

export function getAuditEntitlement(metadata: MetadataInput, selfHostedEnabled = env.auditSelfHostedEnabled): AuditEntitlement {
  if (selfHostedEnabled) return { enabled: true, source: "self_hosted" }
  if (parseOrganizationPlan(metadata).tier === "enterprise") return { enabled: true, source: "enterprise_plan" }
  return { enabled: false, source: "none" }
}

export function getOrganizationEntitlements(
  metadata: MetadataInput,
  options: EntitlementOptions = {},
): OrganizationEntitlements {
  const gatingEnabled = options.gatingEnabled ?? env.planGatingEnabled
  const tier = parseOrganizationPlan(metadata).tier
  const entitled = !gatingEnabled || tier === "enterprise"

  return {
    // SSO / SAML is part of Team. Enforced SSO (orgControls), SCIM, and policies stay on Enterprise.
    sso: !gatingEnabled || tier === "team" || tier === "enterprise",
    desktopPolicies: entitled,
    orgControls: entitled,
    analytics: entitled,
    auditLogs: getAuditEntitlement(metadata).enabled,
    // SCIM provisioning is Enterprise. (SSO, including sign-up through SSO, is Team.)
    scim: entitled,
  }
}

/**
 * Cloud Automations on the shared headless runner are part of Team: they run
 * without an OpenWork Web computer, so they do not need the Web seat.
 */
export function planIncludesHeadlessAutomations(metadata: MetadataInput, options: EntitlementOptions = {}): boolean {
  const gatingEnabled = options.gatingEnabled ?? env.planGatingEnabled
  const tier = parseOrganizationPlan(metadata).tier
  return !gatingEnabled || tier === "team" || tier === "enterprise"
}

export function checkEntitlement(
  metadata: MetadataInput,
  key: EntitlementKey,
  options: EntitlementOptions = {},
): { ok: true } | { ok: false; status: 402; response: EnterprisePlanRequiredError } {
  if (getOrganizationEntitlements(metadata, options)[key]) {
    return { ok: true }
  }

  return {
    ok: false,
    status: 402,
    response: {
      error: "enterprise_plan_required",
      feature: key,
      message:
        key === "sso"
          ? `${ENTITLEMENT_FEATURE_LABELS[key]} requires a Team or Enterprise plan. Upgrade at openworklabs.com/pricing.`
          : `${ENTITLEMENT_FEATURE_LABELS[key]} requires an Enterprise plan. Talk to us at openworklabs.com/enterprise.`,
    },
  }
}
