/**
 * Enterprise plan billing (enterprisePlan feature): only platform admins
 * reach the Enterprise subscription routes, starting one is refused while the
 * feature is off or Stripe Enterprise billing is not configured, and an
 * Enterprise plan set by a platform admin lifts the Free plan user limit only
 * while the feature is on.
 *
 * Stripe seat billing is configured with placeholder keys so the Free plan
 * limit is enforced; no request here reaches Stripe because no organization
 * has a subscription.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary, text } from "./harness.js"

const den = await bootDen({
  env: {
    STRIPE_SECRET_KEY: "sk_test_placeholder_never_called",
    STRIPE_SEAT_PRICE_ID: "price_seat_placeholder",
    STRIPE_ENTERPRISE_PRODUCT_ID: "",
    DEN_DEPLOYMENT: "cloud",
  },
})
after(() => den.close())

// setFeature signs the platform administrator up on first use.
const setup = await den.createOrg(await den.signUp("Setup Owner"), "Enterprise setup org")
assert.equal((await den.setFeature(setup.orgId, "enterprisePlan", false)).status, 200)
const signedIn = await den.signIn(`platform-admin+${den.stamp}@example.test`)
const adminToken = text(field(signedIn.body, "token"), "platform admin session")
const enterprisePath = (orgId: string) => `/v1/admin/organizations/${orgId}/enterprise-subscription`
const startBody = { priceId: "price_enterpriseContract", minimumUsers: 25, billingEmail: "billing@example.test", daysUntilDue: 30 }

test("only a platform administrator can read or start an Enterprise subscription", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Erin Owner"), "Enterprise access org")
  for (const token of [null, owner.token]) {
    for (const method of ["GET", "POST", "PATCH"] as const) {
      const result = await den.request(token, method, enterprisePath(orgId), { body: method === "GET" ? undefined : method === "POST" ? startBody : { minimumUsers: 10 } })
      assert.equal(result.status, token ? 403 : 401, summary(result))
    }
  }
})

test("starting Enterprise is refused while the feature is off, then while Stripe Enterprise billing is not configured", async () => {
  const { orgId } = await den.createOrg(await den.signUp("Eli Owner"), "Enterprise start org")
  assert.equal((await den.setFeature(orgId, "enterprisePlan", false)).status, 200)

  const state = await den.request(adminToken, "GET", enterprisePath(orgId))
  assert.equal(state.status, 200, summary(state))
  assert.equal(field(state.body, "enterprise", "featureEnabled"), false)
  assert.equal(field(state.body, "enterprise", "configured"), false)
  assert.equal(field(state.body, "enterprise", "subscription"), null)
  assert.equal(field(state.body, "enterprise", "users"), 1)

  const off = await den.request(adminToken, "POST", enterprisePath(orgId), { body: startBody })
  assert.equal(off.status, 404, summary(off))
  assert.equal(field(off.body, "error"), "feature_disabled")

  assert.equal((await den.setFeature(orgId, "enterprisePlan", true)).status, 200)
  const invalid = await den.request(adminToken, "POST", enterprisePath(orgId), { body: { ...startBody, priceId: "not-a-price" } })
  assert.equal(invalid.status, 400, summary(invalid))
  const unconfigured = await den.request(adminToken, "POST", enterprisePath(orgId), { body: startBody })
  assert.equal(unconfigured.status, 503, summary(unconfigured))
  assert.equal(field(unconfigured.body, "error"), "enterprise_product_not_configured")

  const noSubscription = await den.request(adminToken, "PATCH", enterprisePath(orgId), { body: { minimumUsers: 10 } })
  assert.equal(noSubscription.status, 503, summary(noSubscription))
})

test("an admin-set Enterprise plan lifts the Free plan user limit only while the feature is on", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Eve Owner"), "Enterprise limit org")
  assert.equal((await den.setFeature(orgId, "enterprisePlan", false)).status, 200)
  for (let index = 1; index <= 4; index += 1) {
    const invited = await den.as(owner, orgId)("POST", "/v1/invitations", { email: `limit-${index}-${den.stamp}@example.test`, role: "member" })
    assert.equal(invited.status < 300, true, summary(invited))
  }
  const sixth = { email: `limit-6-${den.stamp}@example.test`, role: "member" }
  const blocked = await den.as(owner, orgId)("POST", "/v1/invitations", sixth)
  assert.equal(blocked.status, 402, summary(blocked))

  const plan = await den.request(adminToken, "PATCH", `/v1/admin/organizations/${orgId}/plan`, { body: { tier: "enterprise", seatLimit: 1000 } })
  assert.equal(plan.status, 200, summary(plan))
  const stillBlocked = await den.as(owner, orgId)("POST", "/v1/invitations", sixth)
  assert.equal(stillBlocked.status, 402, `the feature is off: ${summary(stillBlocked)}`)

  assert.equal((await den.setFeature(orgId, "enterprisePlan", true)).status, 200)
  const allowed = await den.as(owner, orgId)("POST", "/v1/invitations", sixth)
  assert.equal(allowed.status < 300, true, summary(allowed))
})
