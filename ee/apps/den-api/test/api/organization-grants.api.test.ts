import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text, type Member } from "./harness.js"
import { INFERENCE_FREE_MODEL_ID, INFERENCE_USAGE_CONVERSION_FACTOR } from "@openwork/types/den/inference"
import { organizationControlPanelSchema } from "@openwork/types/den/organization-grants"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

const den = await bootDen({ env: { INFERENCE_FREE_ENABLED: "true", GATEWAY_ENABLED: "true", GATEWAY_PUBLIC_BASE_URL: "http://127.0.0.1:8791", GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:8791", INFERENCE_FREE_OPENAI_API_KEY: "organization-grant-fixture-unused", DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(() => den.close())
const org = await den.createOrg(await den.signUp("Grant Owner"), "Grant test organization")
const other = await den.createOrg(await den.signUp("Other Grant Owner"), "Other grant test organization")
assert.equal((await den.setFeature(org.orgId, "organizationGrants", true)).status, 200)
assert.equal((await den.setFeature(other.orgId, "organizationGrants", true)).status, 200)
const signedIn = await den.signIn(`platform-admin+${den.stamp}@example.test`)
const adminToken = text(field(signedIn.body, "token"), "platform admin session")
const base = (id = org.orgId) => `/v1/admin/organizations/${id}/control-panel`
const admin = (method: "GET" | "PUT" | "POST", path: string, body?: unknown) => den.request(adminToken, method, path, { body })
const award = (change: Record<string, unknown> = {}) => ({ requestId: randomUUID(), feature: "freeAuto", kind: "usage", amountUsd: 25, startsAt: null, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), reason: "Extended evaluation", ...change })
const panel = async (id = org.orgId, history = false) => {
  const call = await admin("GET", `${base(id)}?history=${history ? "1" : "0"}`)
  assert.equal(call.status, 200, summary(call))
  return organizationControlPanelSchema.parse(call.body)
}
const { client, db } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("Grant integration requires the isolated MySQL database")

test("only platform admins can read or mutate grants, and a foreign grant cannot be revoked", async () => {
  for (const [method, path, body] of [
    ["GET", base(), undefined], ["PUT", `${base()}/access`, { feature: "freeAuto", setting: "disabled" }], ["POST", `${base()}/grants`, award()],
  ] as const) {
    assert.equal((await den.request(null, method, path, { body })).status, 401)
    assert.equal((await den.as(org.owner, org.orgId)(method, path, body)).status, 403)
    assert.equal((await den.as(other.owner, other.orgId)(method, path, body)).status, 403)
  }
  const created = await admin("POST", `${base()}/grants`, award())
  assert.equal(created.status, 200, summary(created))
  const grantId = text(field(created.body, "grantId"), "grant id")
  assert.equal((await admin("POST", `${base(other.orgId)}/grants/${grantId}/revoke`)).status, 404)
  assert.equal((await admin("GET", "/v1/admin/organizations/invalid/control-panel")).status, 400)
  await admin("POST", `${base()}/grants/${grantId}/revoke`)
})

test("retrying an award creates one record, conflicts do not double grant, and validation rejects invalid amounts and dates", async () => {
  const input = award({ expiresAt: null, reason: "reason-not-copied-to-audit-7349" })
  const [first, retry] = await Promise.all([admin("POST", `${base()}/grants`, input), admin("POST", `${base()}/grants`, input)])
  assert.equal(first.status, 200, summary(first)); assert.equal(retry.status, 200, summary(retry))
  assert.equal(field(first.body, "grantId"), field(retry.body, "grantId"))
  const state = await panel()
  assert.equal(state.grants.filter(grant => grant.id === field(first.body, "grantId")).length, 1)
  assert.equal(state.grants.find(grant => grant.id === field(first.body, "grantId"))?.expiresAt, null)
  assert.equal((await admin("POST", `${base()}/grants`, { ...input, amountUsd: 100 })).status, 409)
  for (const body of [award({ amountUsd: -1 }), award({ amountUsd: 0 }), award({ amountUsd: 0.001 }), award({ kind: "unlimited", amountUsd: 25 }), award({ feature: "openworkWeb" }), award({ expiresAt: new Date(Date.now() - 60_000).toISOString() }), award({ startsAt: "2039-01-01T00:00:00Z" })]) {
    const refused = await admin("POST", `${base()}/grants`, body)
    assert.equal(refused.status, 400, summary(refused))
  }
  assert.equal((await den.auditStorageText()).includes(input.reason), false)
  await admin("POST", `${base()}/grants/${field(first.body, "grantId")}/revoke`)
})

test("Web access follows start, expiry, explicit disable and revoke; legacy access is replaced deliberately", async () => {
  const future = await admin("POST", `${base()}/grants`, award({ feature: "openworkWeb", kind: "access", amountUsd: null, startsAt: new Date(Date.now() + 86_400_000).toISOString() }))
  assert.equal(future.status, 200, summary(future))
  const id = text(field(future.body, "grantId"), "web grant id")
  const billing = () => den.as(org.owner, org.orgId)("GET", "/v1/billing")
  assert.equal((await panel()).access.openworkWeb.enabled, false)
  await client.execute("UPDATE organization_grant SET starts_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ?", [id])
  const active = await billing()
  assert.equal(active.status, 200, summary(active)); assert.equal(field(active.body, "billing", "stripe", "web", "hasAccess"), true)
  assert.equal((await admin("PUT", `${base()}/access`, { feature: "openworkWeb", setting: "disabled" })).status, 200)
  assert.equal((await panel()).grants.find(grant => grant.id === id)?.state, "blocked")
  assert.equal(field((await billing()).body, "billing", "stripe", "web", "hasAccess"), false)
  await admin("PUT", `${base()}/access`, { feature: "openworkWeb", setting: "default" })
  assert.equal(field((await billing()).body, "billing", "stripe", "web", "hasAccess"), true)
  await client.execute("UPDATE organization_grant SET expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ?", [id])
  assert.equal((await panel(org.orgId, true)).grants.find(grant => grant.id === id)?.state, "expired")
  assert.equal(field((await billing()).body, "billing", "stripe", "web", "hasAccess"), false)
  const legacy = await admin("PUT", `/v1/admin/organizations/${org.orgId}/openwork-web-access`, { enabled: true, reason: "Existing complimentary access" })
  assert.equal(legacy.status, 200, summary(legacy))
  assert.equal((await panel()).legacyWebAccess, true)
  await admin("PUT", `${base()}/access`, { feature: "openworkWeb", setting: "default" })
  assert.equal((await panel()).legacyWebAccess, false)
  assert.equal(field((await billing()).body, "billing", "stripe", "web", "hasAccess"), false)
})

test("Free Auto spends the shared earliest-expiring grant once, preserves finite awards during unlimited access, and rechecks restrictions", async () => {
  const { createFreeAllowanceStore } = await import("../../../gateway/src/free/shared/allowance.js")
  const { readAutoConfig } = await import("../../../gateway/src/free/shared/config.js")
  const { findMemberFreePrincipal } = await import("../../../gateway/src/free/shared/principal.js")
  const { InferenceKeyTable } = await import("@openwork-ee/den-db/schema")
  const { and, eq } = await import("@openwork-ee/den-db/drizzle")
  const store = createFreeAllowanceStore(readAutoConfig(process.env), "member", db)
  async function principalFor(member: Member, organizationId = org.orgId) {
    const credential = await den.as(member, organizationId)("POST", "/v1/inference/free/credential")
    assert.equal(credential.status, 200, summary(credential))
    const [key] = await db.select().from(InferenceKeyTable).where(and(eq(InferenceKeyTable.organization_id, organizationId), eq(InferenceKeyTable.org_membership_id, member.memberId))).limit(1)
    const principal = await findMemberFreePrincipal(key, db)
    assert.ok(principal)
    return principal
  }
  const principal = await principalFor(org.owner)
  async function charge(amountUsd: number, identity = principal) {
    const admission = await store.admit(identity)
    assert.equal(admission.ok, true)
    if (!admission.ok) throw new Error(admission.code)
    const requestId = randomUUID()
    const input = { requestId, principal: identity, windows: admission.windows, grantAdmission: admission.grantAdmission,
      receipt: { eventId: requestId, model: INFERENCE_FREE_MODEL_ID, amount: Math.round(amountUsd * INFERENCE_USAGE_CONVERSION_FACTOR), inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } }
    assert.equal(await store.charge(input), true)
    assert.equal(await store.charge(input), false)
  }
  await charge(5)
  assert.equal((await store.read(principal)).state, "exhausted")
  const later = await admin("POST", `${base()}/grants`, award({ amountUsd: 25, expiresAt: null, reason: "Later grant" }))
  const sooner = await admin("POST", `${base()}/grants`, award({ amountUsd: 5, reason: "Sooner grant" }))
  assert.equal(later.status, 200, summary(later)); assert.equal(sooner.status, 200, summary(sooner))
  await charge(3)
  let state = await panel()
  assert.equal(state.grants.find(grant => grant.id === field(sooner.body, "grantId"))?.usedUsd, 3)
  assert.equal(state.grants.find(grant => grant.id === field(later.body, "grantId"))?.usedUsd, 0)
  await Promise.all([charge(1), charge(1)])
  state = await panel(org.orgId, true)
  assert.equal(state.grants.find(grant => grant.id === field(sooner.body, "grantId"))?.usedUsd, 5)
  const teammate = await principalFor(await den.newMember(org.owner, org.orgId, "Pool teammate"))
  await charge(5, teammate)
  await charge(1, teammate)
  assert.equal((await panel()).grants.find(grant => grant.id === field(later.body, "grantId"))?.usedUsd, 1)
  const foreign = await principalFor(other.owner, other.orgId)
  await charge(5, foreign)
  assert.equal((await store.admit(foreign)).ok, false, "another organization cannot draw this grant pool")
  const unlimited = await admin("POST", `${base()}/grants`, award({ kind: "unlimited", amountUsd: null, reason: "Unlimited trial" }))
  assert.equal(unlimited.status, 200, summary(unlimited))
  await charge(10)
  assert.equal((await panel()).grants.find(grant => grant.id === field(later.body, "grantId"))?.usedUsd, 1)
  assert.equal((await store.read(principal)).allowance?.unlimited, true)
  await admin("PUT", `${base()}/access`, { feature: "freeAuto", setting: "disabled" })
  assert.equal((await store.admit(principal)).ok, false)
  await admin("PUT", `${base()}/access`, { feature: "freeAuto", setting: "default" })
  assert.equal((await store.admit(principal)).ok, true)
  await admin("POST", `${base()}/grants/${field(unlimited.body, "grantId")}/revoke`)
  assert.equal((await store.read(principal)).allowance?.unlimited, false)
  await admin("POST", `${base()}/grants/${field(later.body, "grantId")}/revoke`)
  assert.equal((await store.read(principal)).state, "exhausted")
  assert.ok(list(field((await admin("GET", `${base()}?history=1`)).body, "grants")).some(grant => grant.state === "revoked"))
})

test("turning the rollout off restores legacy behavior and does not delete grant history", async () => {
  const created = await admin("POST", `${base()}/grants`, award({ expiresAt: null }))
  assert.equal(created.status, 200, summary(created))
  await den.setFeature(org.orgId, "organizationGrants", false)
  assert.equal((await panel()).enabled, false)
  assert.equal((await admin("POST", `${base()}/grants`, award())).status, 404)
  await den.setFeature(org.orgId, "organizationGrants", true)
  assert.ok((await panel()).grants.some(grant => grant.id === field(created.body, "grantId")))
})

test("grants do not lift the managed-model policy or replace an ongoing paid Web subscription", async () => {
  const granted = await admin("POST", `${base(other.orgId)}/grants`, award({ kind: "unlimited", amountUsd: null }))
  assert.equal(granted.status, 200, summary(granted))
  const dpa = await den.request(adminToken, "PATCH", `/v1/admin/organizations/${other.orgId}/dpa`, { body: { dpaSigned: true, reason: "Managed model policy witness" } })
  assert.equal(dpa.status, 200, summary(dpa))
  assert.equal((await panel(other.orgId)).access.freeAuto.enabled, false)
  const denied = await den.as(other.owner, other.orgId)("POST", "/v1/inference/free/credential")
  assert.equal(denied.status, 403, summary(denied))
  await client.execute("INSERT INTO org_subscriptions (id, organization_id, type, status, stripe_customer_id, stripe_subscription_id) VALUES (?, ?, 'web', 'active', 'cus_grant_fixture', 'sub_grant_fixture')", [createDenTypeId("orgSubscription"), other.orgId])
  const web = await admin("POST", `${base(other.orgId)}/grants`, award({ feature: "openworkWeb", kind: "access", amountUsd: null }))
  assert.equal(web.status, 409, summary(web))
  assert.equal((await admin("PUT", `${base(other.orgId)}/access`, { feature: "openworkWeb", setting: "enabled" })).status, 409)
  assert.equal((await admin("PUT", `${base(other.orgId)}/access`, { feature: "openworkWeb", setting: "disabled" })).status, 200)
  const [rows] = await client.execute("SELECT status FROM org_subscriptions WHERE organization_id = ? AND type = 'web'", [other.orgId])
  assert.equal(list(rows)[0]?.status, "active")
})
