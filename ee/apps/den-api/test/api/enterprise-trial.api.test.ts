/**
 * Enterprise trials: a platform admin starts one from the organization's
 * Control panel with seats and an end date. The organization is Enterprise in
 * the product, its users are limited to the trial's seats, and when the trial
 * ends (by date or by an admin) it returns to Free with its earlier Free plan
 * user limit.
 *
 * Stripe seat billing is configured with placeholder keys so the user limit is
 * enforced; no request here reaches Stripe because no organization has a
 * subscription.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary, text } from "./harness.js"

const den = await bootDen({
  env: {
    STRIPE_SECRET_KEY: "sk_test_placeholder_never_called",
    STRIPE_SEAT_PRICE_ID: "price_seat_placeholder",
    DEN_DEPLOYMENT: "cloud",
  },
})
after(() => den.close())

const { endExpiredEnterpriseTrialsOnce } = await import("../../src/enterprise-trial.js")

// setFeature signs the platform administrator up on first use.
const setup = await den.createOrg(await den.signUp("Trial Setup Owner"), "Trial setup org")
assert.equal((await den.setFeature(setup.orgId, "enterprisePlan", false)).status, 200)
const signedIn = await den.signIn(`platform-admin+${den.stamp}@example.test`)
const adminToken = text(field(signedIn.body, "token"), "platform admin session")

const trialPath = (orgId: string) => `/v1/admin/organizations/${orgId}/enterprise-trial`
const statePath = (orgId: string) => `/v1/admin/organizations/${orgId}/enterprise-subscription`
const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

async function orgWithTrialFeature(name: string) {
  const created = await den.createOrg(await den.signUp(`${name} Owner`), `${name} org`)
  assert.equal((await den.setFeature(created.orgId, "enterprisePlan", true)).status, 200)
  return created
}

async function invite(owner: Parameters<typeof den.as>[0], orgId: string, label: string) {
  return den.as(owner, orgId)("POST", "/v1/invitations", { email: `${label}-${den.stamp}@example.test`, role: "member" })
}

test("only a platform administrator can start or end a trial", async () => {
  const { orgId, owner } = await orgWithTrialFeature("Trial Access")
  for (const token of [null, owner.token]) {
    const start = await den.request(token, "PUT", trialPath(orgId), { body: { seats: 10, endsAt: daysFromNow(30) } })
    assert.equal(start.status, token ? 403 : 401, summary(start))
    const end = await den.request(token, "DELETE", trialPath(orgId))
    assert.equal(end.status, token ? 403 : 401, summary(end))
  }
})

test("a trial is Enterprise in the product and holds users to its seats", async () => {
  const { orgId, owner } = await orgWithTrialFeature("Trial Seats")
  const endsAt = daysFromNow(30)
  const started = await den.request(adminToken, "PUT", trialPath(orgId), { body: { seats: 6, endsAt } })
  assert.equal(started.status, 200, summary(started))
  assert.equal(field(started.body, "enterprise", "plan", "source"), "trial")
  assert.equal(field(started.body, "enterprise", "plan", "trial", "seats"), 6)
  assert.equal(field(started.body, "enterprise", "freeSeatCount"), 6)

  const org = await den.request(owner.token, "GET", "/v1/org", { orgId })
  assert.equal(org.status, 200, summary(org))
  assert.deepEqual(field(org.body, "plan"), { tier: "enterprise", source: "trial", trial: { seats: 6, endsAt } })

  const detail = await den.request(adminToken, "GET", `/v1/admin/organizations/${orgId}`)
  assert.equal(field(detail.body, "organization", "planSource"), "trial")
  assert.equal(field(detail.body, "organization", "trialEndsAt"), endsAt)

  for (const label of ["seat-2", "seat-3", "seat-4", "seat-5", "seat-6"]) {
    const invited = await invite(owner, orgId, label)
    assert.equal(invited.status < 300, true, summary(invited))
  }
  const full = await invite(owner, orgId, "seat-7")
  assert.equal(full.status, 402, summary(full))
  assert.match(String(field(full.body, "message")), /Enterprise trial includes 6 users/)

  const billing = await den.request(owner.token, "GET", "/v1/billing", { orgId })
  assert.equal(billing.status, 200, summary(billing))
  assert.equal(field(billing.body, "billing", "plan", "tier"), "enterprise")
  assert.deepEqual(field(billing.body, "billing", "plan", "trial"), { seats: 6, endsAt })

  const raised = await den.request(adminToken, "PUT", trialPath(orgId), { body: { seats: 7, endsAt: daysFromNow(45) } })
  assert.equal(raised.status, 200, summary(raised))
  const fits = await invite(owner, orgId, "seat-7")
  assert.equal(fits.status < 300, true, summary(fits))
})

test("ending a trial returns to Free and restores the earlier Free plan user limit", async () => {
  const { orgId, owner } = await orgWithTrialFeature("Trial End")
  const freeSeats = await den.request(adminToken, "PATCH", `/v1/admin/organizations/${orgId}/free-seats`, { body: { totalFreeSeats: 7 } })
  assert.equal(freeSeats.status, 200, summary(freeSeats))
  assert.equal((await den.request(adminToken, "PUT", trialPath(orgId), { body: { seats: 25, endsAt: daysFromNow(30) } })).status, 200)

  const ended = await den.request(adminToken, "DELETE", trialPath(orgId))
  assert.equal(ended.status, 200, summary(ended))
  assert.equal(field(ended.body, "enterprise", "plan", "tier"), "free")
  assert.equal(field(ended.body, "enterprise", "plan", "trial"), null)
  assert.equal(field(ended.body, "enterprise", "plan", "lastTrial", "reason"), "ended_by_admin")
  assert.equal(field(ended.body, "enterprise", "freeSeatCount"), 7)
  const org = await den.request(owner.token, "GET", "/v1/org", { orgId })
  assert.equal(field(org.body, "plan", "tier"), "free")

  const again = await den.request(adminToken, "DELETE", trialPath(orgId))
  assert.equal(again.status, 404, summary(again))
})

test("an expired trial is closed by the expiry job", async () => {
  const { orgId } = await orgWithTrialFeature("Trial Expiry")
  assert.equal((await den.request(adminToken, "PUT", trialPath(orgId), { body: { seats: 12, endsAt: daysFromNow(1) } })).status, 200)
  await endExpiredEnterpriseTrialsOnce(new Date(Date.now() + 2 * 86_400_000))
  const state = await den.request(adminToken, "GET", statePath(orgId))
  assert.equal(field(state.body, "enterprise", "plan", "tier"), "free")
  assert.equal(field(state.body, "enterprise", "plan", "lastTrial", "reason"), "expired")
  assert.equal(field(state.body, "enterprise", "freeSeatCount"), 5)
})

test("starting a trial needs the feature, valid seats and a future end date; setting a plan by hand ends it", async () => {
  const { orgId } = await orgWithTrialFeature("Trial Rules")
  assert.equal((await den.request(adminToken, "PUT", trialPath(orgId), { body: { seats: 4, endsAt: daysFromNow(30) } })).status, 400)
  const past = await den.request(adminToken, "PUT", trialPath(orgId), { body: { seats: 5, endsAt: daysFromNow(-1) } })
  assert.equal(past.status, 400, summary(past))
  assert.equal(field(past.body, "error"), "ends_at_in_past")

  assert.equal((await den.request(adminToken, "PUT", trialPath(orgId), { body: { seats: 9, endsAt: daysFromNow(30) } })).status, 200)
  const manual = await den.request(adminToken, "PATCH", `/v1/admin/organizations/${orgId}/plan`, { body: { tier: "enterprise", seatLimit: 50 } })
  assert.equal(manual.status, 200, summary(manual))
  const state = await den.request(adminToken, "GET", statePath(orgId))
  assert.equal(field(state.body, "enterprise", "plan", "source"), "manual")
  assert.equal(field(state.body, "enterprise", "plan", "trial"), null)
  assert.equal(field(state.body, "enterprise", "freeSeatCount"), 5)

  assert.equal((await den.setFeature(orgId, "enterprisePlan", false)).status, 200)
  const off = await den.request(adminToken, "PUT", trialPath(orgId), { body: { seats: 9, endsAt: daysFromNow(30) } })
  assert.equal(off.status, 404, summary(off))
  assert.equal(field(off.body, "error"), "feature_disabled")
})
