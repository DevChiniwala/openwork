import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary } from "./harness.js"

const den = await bootDen({ env: {
  INFERENCE_FREE_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_fixture_only",
  STRIPE_INFERENCE_PRICE_ID: "price_fixture_only", OPENROUTER_MANAGEMENT_API_KEY: "fixture_management_key",
} })
after(() => den.close())

test("only a live signed-in member gets their own recovery options and current purchase permissions", async () => {
  const path = "/v1/workbot/model-recovery"
  const { orgId, owner } = await den.createOrg(await den.signUp("Workspace Owner"), "Recovery workspace")
  const other = await den.createOrg(owner, "Other workspace")
  const member = await den.newMember(owner, orgId, "Workspace Member")
  const ownerToken = await den.mintMcpToken(owner, orgId)
  const memberToken = await den.mintMcpToken(member, orgId)
  assert.equal((await den.request(null, "GET", path)).status, 401)
  assert.equal((await den.request(ownerToken, "GET", path)).status, 404)
  assert.equal((await den.setFeature(orgId, "workbotUsageRecovery", true)).status, 200)
  const ownerOptions = await den.request(ownerToken, "GET", path, { orgId: other.orgId })
  assert.equal(ownerOptions.status, 200, summary(ownerOptions))
  assert.equal(ownerOptions.headers.get("cache-control"), "no-store")
  assert.deepEqual(ownerOptions.body, { canUpgrade: false, purchaseEligible: true, paidContinuation: "unavailable", upgradeBlockedReason: "paid_workbot_route_unavailable", canManageModels: true, canManageBilling: true, freeExhausted: false, freeResetsAt: null })
  // Arrange exhausted accounting in the disposable database; every observation
  // still crosses the authenticated API as the member who owns the allowance.
  const [{ db }, { eq }, { InferenceFreeUsageBucketTable, OrganizationTable, OrgSubscriptionTable }, { createDenTypeId, normalizeDenTypeId }, { freeInferenceDigest }, { freeInferenceWindow, INFERENCE_USAGE_CONVERSION_FACTOR }] = await Promise.all([
    import("../../src/db.js"), import("@openwork-ee/den-db/drizzle"), import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/utils/typeid"), import("@openwork-ee/utils/free-inference-digest"), import("@openwork/types/den/inference"),
  ])
  const window = freeInferenceWindow()
  await db.insert(InferenceFreeUsageBucketTable).values({ id: freeInferenceDigest("test-bucket", owner.userId), identity_hash: freeInferenceDigest("member", owner.userId),
    window_start_at: window.start, window_end_at: window.end, limit_amount: 5 * INFERENCE_USAGE_CONVERSION_FACTOR, used_amount: 5 * INFERENCE_USAGE_CONVERSION_FACTOR })
  const exhausted = await den.request(ownerToken, "GET", path)
  assert.equal(field(exhausted.body, "purchaseEligible"), true)
  assert.equal(field(exhausted.body, "canUpgrade"), false, "checkout cannot restore Gateway access, even for an eligible purchaser")
  assert.equal(field(exhausted.body, "freeExhausted"), true)
  assert.equal(field(exhausted.body, "freeResetsAt"), window.end.toISOString())
  await db.insert(InferenceFreeUsageBucketTable).values({ id: freeInferenceDigest("test-bucket", member.userId), identity_hash: freeInferenceDigest("member", member.userId),
    window_start_at: window.start, window_end_at: window.end, limit_amount: 5 * INFERENCE_USAGE_CONVERSION_FACTOR, used_amount: 5 * INFERENCE_USAGE_CONVERSION_FACTOR })
  const memberOptions = await den.request(memberToken, "GET", path)
  assert.equal(memberOptions.status, 200, summary(memberOptions))
  assert.deepEqual(memberOptions.body, { canUpgrade: false, purchaseEligible: false, paidContinuation: "unavailable", upgradeBlockedReason: "paid_workbot_route_unavailable", canManageModels: false, canManageBilling: false, freeExhausted: true, freeResetsAt: window.end.toISOString() })
  const organizationId = normalizeDenTypeId("organization", orgId)
  await db.insert(OrgSubscriptionTable).values({ id: createDenTypeId("orgSubscription"), organization_id: organizationId, type: "inference", status: "past_due", stripe_customer_id: "cus_recovery_fixture", stripe_subscription_id: "sub_recovery_fixture" })
  const subscribed = await den.request(ownerToken, "GET", path)
  assert.equal(field(subscribed.body, "purchaseEligible"), false, "an existing past-due subscription gets no new-subscription offer")
  assert.equal(field(subscribed.body, "freeExhausted"), true, "paid organizations retain the member’s exhausted weekly Auto allowance")
  await db.update(OrgSubscriptionTable).set({ status: "active" }).where(eq(OrgSubscriptionTable.organization_id, organizationId))
  const activeSubscriber = await den.request(ownerToken, "GET", path)
  assert.equal(field(activeSubscriber.body, "purchaseEligible"), false)
  assert.equal(field(activeSubscriber.body, "freeExhausted"), true, "an active subscription does not refill Auto")
  await db.delete(OrgSubscriptionTable).where(eq(OrgSubscriptionTable.organization_id, organizationId))
  await db.update(OrganizationTable).set({ metadata: { dpaSigned: true } }).where(eq(OrganizationTable.id, organizationId))
  const policyBlocked = await den.request(ownerToken, "GET", path)
  assert.equal(field(policyBlocked.body, "canUpgrade"), false)
  assert.equal(field(policyBlocked.body, "freeResetsAt"), null, "unavailable managed access must not claim a free reset will restore it")
  const noFeature = await den.mintMcpToken(other.owner, other.orgId)
  assert.equal((await den.request(noFeature, "GET", path, { orgId })).status, 404, "a browser-selected organization grants no rollout access")
  assert.equal(field((await den.request(ownerToken, "GET", "/v1/workbot/session")).body, "usageRecovery"), true)
  const removed = await den.as(owner, orgId)("DELETE", `/v1/members/${member.memberId}`)
  assert.ok(removed.status < 300, summary(removed))
  assert.equal((await den.request(memberToken, "GET", path)).status, 401)
  assert.equal((await den.setFeature(orgId, "workbotUsageRecovery", false)).status, 200)
  assert.equal((await den.request(ownerToken, "GET", path)).status, 404)
})
