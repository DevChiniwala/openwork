import assert from "node:assert/strict"
import { test } from "node:test"

// Importing these modules never touches the database; the values only satisfy env validation.
for (const [name, value] of Object.entries({
  OPENWORK_DEV_MODE: "1",
  DB_MODE: "mysql",
  DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_den",
  DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
  BETTER_AUTH_SECRET: "local-dev-secret-not-for-production-use!!",
  BETTER_AUTH_URL: "http://localhost:8790",
})) {
  if (!process.env[name]?.trim()) process.env[name] = value
}

const { reconcileOrganizationPlan } = await import("../src/billing-plans.js")
const { calculateOrganizationBillingQuantities } = await import("../src/billing-quantities.js")
const { getOrganizationEntitlements, parseOrganizationPlan, planLiftsUserLimit, publicOrganizationPlan } = await import("../src/entitlements.js")
const { metadataWithEnterpriseTrial, metadataWithoutEnterpriseTrial } = await import("../src/enterprise-trial-rules.js")

// Entitlements read the plan at the real time, so the trial is placed around it.
const now = new Date()
const days = (count: number) => new Date(now.getTime() + count * 86_400_000)
const in30Days = days(30)

function started(current: Record<string, unknown>, seats = 20, endsAt = in30Days) {
  const result = metadataWithEnterpriseTrial(current, { seats, endsAt, now, startedByUserId: "usr_admin" })
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error(result.error)
  return result.metadata
}

test("a trial makes the organization fully Enterprise until it ends", () => {
  const metadata = started({})
  const plan = parseOrganizationPlan(metadata, now)
  assert.equal(plan.tier, "enterprise")
  assert.equal(plan.source, "trial")
  const entitlements = getOrganizationEntitlements(metadata, { gatingEnabled: true })
  assert.equal(entitlements.scim, true)
  assert.equal(entitlements.orgControls, true)
  assert.equal(entitlements.analytics, true)
  assert.equal(entitlements.desktopPolicies, true)
  assert.equal(entitlements.sso, true)
})

test("the trial's seats become the Free plan user limit, and the trial does not lift it", () => {
  const metadata = started({ seatsFreeAdditional: 3 }, 20)
  assert.equal(metadata.seatsFreeAdditional, 15)
  assert.equal(calculateOrganizationBillingQuantities({ users: 0, metadata }).seats.free, 20)
  assert.deepEqual(metadata.limits, { members: 20 })
  assert.equal(planLiftsUserLimit(parseOrganizationPlan(metadata, now)), false)
  assert.equal(planLiftsUserLimit({ tier: "enterprise", source: "manual" }), true)
})

test("a trial past its end date reads as Free, even before it is closed", () => {
  const metadata = started({})
  const plan = parseOrganizationPlan(metadata, new Date(in30Days.getTime() + 1))
  assert.equal(plan.tier, "free")
  assert.equal(plan.trialExpired, true)
})

test("an unreadable trial record never unlocks Enterprise", () => {
  const plan = parseOrganizationPlan({ plan: { tier: "enterprise", source: "trial", trial: { seats: "lots" } } }, now)
  assert.equal(plan.tier, "free")
})

test("changing a running trial keeps its start and what to restore", () => {
  const first = started({ seatsFreeAdditional: 3, limits: { members: 8, workers: 1 } }, 20)
  const changed = metadataWithEnterpriseTrial(first, { seats: 40, endsAt: days(60), now, startedByUserId: "usr_other" })
  assert.equal(changed.ok, true)
  if (!changed.ok) return
  assert.equal(changed.trial.previousSeatsFreeAdditional, 3)
  assert.equal(changed.trial.startedAt, now.toISOString())
  assert.equal(changed.metadata.seatsFreeAdditional, 35)
  const ended = metadataWithoutEnterpriseTrial(changed.metadata, { endedAt: now, reason: "ended_by_admin" })
  assert.ok(ended)
  assert.deepEqual(ended.limits, { members: 8, workers: 1 })
})

test("ending a trial returns to Free, restores the Free plan user limit and keeps a record", () => {
  const metadata = started({ seatsFreeAdditional: 3, requireSso: false }, 20)
  const ended = metadataWithoutEnterpriseTrial(metadata, { endedAt: in30Days, reason: "expired" })
  assert.ok(ended)
  assert.equal(ended.seatsFreeAdditional, 3)
  assert.equal(ended.requireSso, false)
  assert.deepEqual(parseOrganizationPlan(ended, in30Days), { tier: "free", source: "default" })
  assert.deepEqual(ended.plan, { tier: "free", source: "default", lastTrial: { seats: 20, startedAt: now.toISOString(), endsAt: in30Days.toISOString(), endedAt: in30Days.toISOString(), reason: "expired" } })

  const noExtra = metadataWithoutEnterpriseTrial(started({}), { endedAt: now, reason: "expired" })
  assert.ok(noExtra)
  assert.equal("seatsFreeAdditional" in noExtra, false)
  assert.equal(metadataWithoutEnterpriseTrial({ plan: { tier: "enterprise", source: "manual" } }, { endedAt: now, reason: "expired" }), null)
})

test("starting a trial is refused for bad input and for a paid Enterprise plan", () => {
  const start = (current: Record<string, unknown>, seats: number, endsAt: Date) => metadataWithEnterpriseTrial(current, { seats, endsAt, now, startedByUserId: null })
  assert.deepEqual(start({}, 0, in30Days), { ok: false, error: "seats_invalid" })
  assert.deepEqual(start({}, 2.5, in30Days), { ok: false, error: "seats_invalid" })
  assert.deepEqual(start({}, 4, in30Days), { ok: false, error: "seats_invalid" })
  assert.deepEqual(start({}, 10, now), { ok: false, error: "ends_at_in_past" })
  assert.deepEqual(start({}, 10, days(400)), { ok: false, error: "ends_at_too_far" })
  assert.deepEqual(start({ plan: { tier: "enterprise", source: "stripe" } }, 10, in30Days), { ok: false, error: "paid_enterprise_plan" })
  assert.equal(start({ plan: { tier: "enterprise", source: "manual" } }, 10, in30Days).ok, true)
  assert.equal(start({ plan: { tier: "team", source: "stripe" } }, 10, in30Days).ok, true)
})

test("Stripe keeps a trial over Team, and paying for Enterprise ends it", () => {
  const trial = parseOrganizationPlan(started({}), now)
  assert.equal(reconcileOrganizationPlan({ current: trial, status: "active", tier: "team" }), null)
  assert.deepEqual(reconcileOrganizationPlan({ current: trial, status: "active", tier: "enterprise" }), { tier: "enterprise", source: "stripe" })
  assert.equal(reconcileOrganizationPlan({ current: trial, status: "canceled", tier: "team" }), null)
})

test("members see the trial's seats and end date, not its bookkeeping", () => {
  const plan = publicOrganizationPlan(parseOrganizationPlan(started({ seatsFreeAdditional: 3 }), now))
  assert.deepEqual(plan, { tier: "enterprise", source: "trial", trial: { seats: 20, endsAt: in30Days.toISOString() } })
})
