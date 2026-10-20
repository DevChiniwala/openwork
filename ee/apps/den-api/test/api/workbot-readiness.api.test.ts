/**
 * GET /v1/org/workbot-readiness: Den web asks it before sending someone to Workbot.
 * - gatewayRequired follows cloudAgentGateway for the organization (the registry, not env or metadata);
 * - hasGatewayProvider is true only for an active AI Gateway provider of this organization: a disabled one and
 *   another organization's do not count;
 * - any member can read it (they cannot list providers), it names nothing, and non-members are refused.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary, text, type Call } from "./harness.js"

// Only the outside model catalog is synthetic; providers are created through Den's real API.
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url !== "https://models.openworklabs.com/api.json") return realFetch(input, init)
  return Response.json({
    openai: { id: "openai", name: "Fixture OpenAI", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"], api: "https://api.openai.com/v1", models: {
      "gpt-6-luna": { id: "gpt-6-luna", name: "Fixture Luna", limit: { context: 100000, output: 1000 } },
    } },
  })
}
const gatewayBaseUrl = "http://127.0.0.1:8791"
const den = await bootDen({ env: { GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: gatewayBaseUrl, GATEWAY_PUBLIC_BASE_URL: gatewayBaseUrl } })
after(async () => { globalThis.fetch = realFetch; await den.close() })

const path = "/v1/org/workbot-readiness"

function readiness(call: Call) {
  assert.equal(call.status, 200, summary(call))
  assert.equal(call.headers.get("cache-control"), "no-store")
  assert.ok(call.body && typeof call.body === "object" && !Array.isArray(call.body))
  // Content-free: exactly two booleans, never provider names, counts or ids.
  assert.deepEqual(Object.keys(call.body).sort(), ["gatewayRequired", "hasGatewayProvider"])
  return { gatewayRequired: field(call.body, "gatewayRequired"), hasGatewayProvider: field(call.body, "hasGatewayProvider") }
}

test("Workbot readiness follows cloudAgentGateway and counts only this organization's active AI Gateway providers", { timeout: 90_000 }, async () => {
  const a = await den.createOrg(await den.signUp("Readiness Owner A"), "Readiness workspace A")
  const b = await den.createOrg(await den.signUp("Readiness Owner B"), "Readiness workspace B")
  const member = await den.newMember(a.owner, a.orgId, "Readiness Member")
  const owner = den.as(a.owner, a.orgId)
  const asMember = den.as(member, a.orgId)
  const otherOwner = den.as(b.owner, b.orgId)

  // Flag off: Workbot doesn't need the Gateway, and providers aren't looked at.
  for (const org of [a, b]) assert.equal((await den.setFeature(org.orgId, "cloudAgentGateway", false)).status, 200)
  assert.deepEqual(readiness(await asMember("GET", path)), { gatewayRequired: false, hasGatewayProvider: false })

  // Flag on, no provider anywhere.
  for (const org of [a, b]) assert.equal((await den.setFeature(org.orgId, "cloudAgentGateway", true)).status, 200)
  assert.deepEqual(readiness(await asMember("GET", path)), { gatewayRequired: true, hasGatewayProvider: false })
  assert.deepEqual(readiness(await owner("GET", path)), { gatewayRequired: true, hasGatewayProvider: false })

  // Another organization's active provider does not count.
  const foreign = await otherOwner("POST", "/v1/inference-providers", { name: "Other org OpenAI", providerId: "openai", modelIds: ["gpt-6-luna"] })
  assert.equal(foreign.status, 201, summary(foreign))
  assert.deepEqual(readiness(await asMember("GET", path)), { gatewayRequired: true, hasGatewayProvider: false })
  assert.deepEqual(readiness(await otherOwner("GET", path)), { gatewayRequired: true, hasGatewayProvider: true })

  // A disabled provider does not count.
  const disabled = await owner("POST", "/v1/inference-providers", { name: "Disabled OpenAI", providerId: "openai", modelIds: ["gpt-6-luna"], status: "disabled" })
  assert.equal(disabled.status, 201, summary(disabled))
  assert.deepEqual(readiness(await asMember("GET", path)), { gatewayRequired: true, hasGatewayProvider: false })

  // An active provider counts, for every member, even one without a grant to it.
  const created = await owner("POST", "/v1/inference-providers", { name: "Active OpenAI", providerId: "openai", modelIds: ["gpt-6-luna"] })
  assert.equal(created.status, 201, summary(created))
  const providerId = text(field(created.body, "inferenceProvider", "id"), "provider id")
  const memberView = await asMember("GET", path)
  assert.deepEqual(readiness(memberView), { gatewayRequired: true, hasGatewayProvider: true })
  assert.ok(!memberView.text.includes(providerId) && !memberView.text.includes("Active OpenAI"))

  // Disabling it makes Workbot unready again; killing the flag makes the Gateway irrelevant.
  const paused = await owner("PATCH", `/v1/inference-providers/${providerId}`, { status: "disabled" })
  assert.equal(paused.status, 200, summary(paused))
  assert.deepEqual(readiness(await asMember("GET", path)), { gatewayRequired: true, hasGatewayProvider: false })
  assert.equal((await den.setFeature(a.orgId, "cloudAgentGateway", false)).status, 200)
  assert.deepEqual(readiness(await asMember("GET", path)), { gatewayRequired: false, hasGatewayProvider: false })
})

test("Workbot readiness is refused without a session or outside the organization", { timeout: 60_000 }, async () => {
  const a = await den.createOrg(await den.signUp("Readiness Owner C"), "Readiness workspace C")
  const outsider = await den.createOrg(await den.signUp("Readiness Outsider"), "Readiness outsider workspace")

  const anonymous = await den.request(null, "GET", path, { orgId: a.orgId })
  assert.equal(anonymous.status, 401, summary(anonymous))

  // Naming an organization the caller doesn't belong to never answers for it.
  const foreign = await den.as(outsider.owner, a.orgId)("GET", path)
  assert.equal(foreign.status, 404, summary(foreign))
  assert.equal(field(foreign.body, "gatewayRequired"), undefined)
})
