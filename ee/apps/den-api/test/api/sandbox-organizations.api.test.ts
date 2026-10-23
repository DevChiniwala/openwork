/**
 * Sandbox organizations: platform admins create try-it-out organizations behind the cloud-only sandboxOrgs
 * rollout; anyone with the join link joins as a member until the seats run out, the sandbox closes, or the
 * link is replaced. Closing stops Free Auto without removing members.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud", INFERENCE_FREE_ENABLED: "true" } })
after(() => den.close())

const admin = await den.signUp("Platform Admin", `platform-admin+${den.stamp}@example.test`)
const create = (body: Record<string, unknown>) => den.request(admin.token, "POST", "/v1/admin/sandbox-orgs", {
  body: { name: "Trial sandbox", connectorBaseUrl: "http://127.0.0.1:9/", days: 14, memberLimit: 3, allowedEmailDomains: [], extraFreeAutoUsd: null, ...body },
})
const tokenOf = (sandbox: unknown) => text(new URL(text(field(sandbox, "joinLink"), "join link")).searchParams.get("token"), "join token")
const join = (token: string, joinToken: string) => den.request(token, "POST", "/v1/sandbox-join", { body: { token: joinToken } })
const freeAuto = async (orgId: string) => field((await den.request(admin.token, "GET", `/v1/admin/organizations/${orgId}/control-panel`)).body, "access", "freeAuto", "enabled")

test("sandboxes stay unavailable until the platform turns the rollout on", async () => {
  const listed = await den.request(admin.token, "GET", "/v1/admin/sandbox-orgs")
  assert.equal(listed.status, 200, summary(listed))
  assert.equal(field(listed.body, "enabled"), false)
  const refused = await create({})
  assert.equal(refused.status, 404, summary(refused))
  assert.equal(field(refused.body, "error"), "feature_disabled")
  const enabled = await den.request(admin.token, "PUT", "/v1/admin/features/sandboxOrgs", { body: { enabled: true } })
  assert.equal(enabled.status, 200, summary(enabled))
})

test("only platform admins create or list sandboxes", async () => {
  const person = await den.signUp("Not Admin")
  assert.equal((await den.request(person.token, "GET", "/v1/admin/sandbox-orgs")).status, 403)
  assert.equal((await den.request(person.token, "POST", "/v1/admin/sandbox-orgs", { body: { name: "Nope", connectorBaseUrl: null, days: 1, memberLimit: 1, allowedEmailDomains: [], extraFreeAutoUsd: null } })).status, 403)
})

test("a sandbox gets five per-person connectors, Free Auto and a join link that makes people members until seats run out", async () => {
  const created = await create({ extraFreeAutoUsd: 10 })
  assert.equal(created.status, 200, summary(created))
  const sandbox = field(created.body, "sandbox")
  const orgId = text(field(sandbox, "organizationId"), "organization id")
  assert.equal(field(sandbox, "connectorCount"), 5)
  assert.equal(field(sandbox, "memberCount"), 1, "the creating admin is the only member")
  assert.equal(await freeAuto(orgId), true)
  const joinToken = tokenOf(sandbox)

  const connections = list(field((await den.as(admin, orgId)("GET", "/v1/mcp-connections")).body, "connections"))
  assert.deepEqual(connections.map((entry) => entry.name).sort(), ["Calendar", "Confluence", "Drive", "Jira", "Outlook"])
  assert.ok(connections.every((entry) => entry.authType === "oauth" && entry.credentialMode === "per_member"), JSON.stringify(connections))

  const preview = await den.request(null, "GET", `/v1/sandbox-join/preview?token=${joinToken}`)
  assert.equal(preview.status, 200, summary(preview))
  assert.equal(field(preview.body, "state"), "open")
  assert.equal((await den.request(null, "GET", "/v1/sandbox-join/preview?token=not-a-real-token")).status, 404)
  assert.equal((await den.request(null, "POST", "/v1/sandbox-join", { body: { token: joinToken } })).status, 401)

  const avery = await den.signUp("Avery Trial")
  const joined = await join(avery.token, joinToken)
  assert.equal(joined.status, 200, summary(joined))
  assert.equal(field(joined.body, "alreadyMember"), false)
  assert.equal(field((await join(avery.token, joinToken)).body, "alreadyMember"), true, "joining again is harmless")
  const context = await den.request(avery.token, "GET", "/v1/org", { orgId })
  assert.equal(field(context.body, "currentMember", "role"), "member", summary(context))

  await join((await den.signUp("Riley Trial")).token, joinToken)
  const late = await join((await den.signUp("Casey Late")).token, joinToken)
  assert.equal(late.status, 409, summary(late))
  assert.equal(field(late.body, "error"), "sandbox_full")
})

test("closing stops joins and Free Auto, keeps members, and extending reopens both", async () => {
  const sandbox = field((await create({ memberLimit: 10 })).body, "sandbox")
  const id = text(field(sandbox, "id"), "sandbox id"), orgId = text(field(sandbox, "organizationId"), "organization id")
  const joinToken = tokenOf(sandbox)
  assert.equal((await join((await den.signUp("Early Member")).token, joinToken)).status, 200)

  const closed = await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/close`)
  assert.equal(field(closed.body, "sandbox", "state"), "closed", summary(closed))
  assert.equal(field(closed.body, "sandbox", "memberCount"), 2)
  assert.equal(await freeAuto(orgId), false)
  const refused = await join((await den.signUp("After Close")).token, joinToken)
  assert.equal(field(refused.body, "error"), "sandbox_closed", summary(refused))

  const extended = await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/extend`, { body: { days: 7 } })
  assert.equal(field(extended.body, "sandbox", "state"), "open", summary(extended))
  assert.equal(await freeAuto(orgId), true)
})

test("replacing the link stops the old one; a domain-limited sandbox refuses other email domains", async () => {
  const sandbox = field((await create({ allowedEmailDomains: ["allowed.test"] })).body, "sandbox")
  const id = text(field(sandbox, "id"), "sandbox id"), oldToken = tokenOf(sandbox)
  const outsider = await join((await den.signUp("Other Domain")).token, oldToken)
  assert.equal(field(outsider.body, "error"), "account_email_domain_not_allowed", summary(outsider))

  const rotated = await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/rotate-link`)
  const newToken = tokenOf(field(rotated.body, "sandbox"))
  assert.notEqual(newToken, oldToken)
  assert.equal((await den.request(null, "GET", `/v1/sandbox-join/preview?token=${oldToken}`)).status, 404)
  const insider = await den.signUp("Allowed Person", `allowed+${den.stamp}@allowed.test`)
  assert.equal((await join(insider.token, newToken)).status, 200)
})

test("the kill switch stops join links everywhere without deleting sandboxes", async () => {
  const sandbox = field((await create({})).body, "sandbox")
  const killed = await den.request(admin.token, "PUT", "/v1/admin/features/sandboxOrgs", { body: { killed: true } })
  assert.equal(killed.status, 200, summary(killed))
  assert.equal((await join((await den.signUp("During Kill")).token, tokenOf(sandbox))).status, 404)
  await den.request(admin.token, "PUT", "/v1/admin/features/sandboxOrgs", { body: { killed: false } })
  const listed = await den.request(admin.token, "GET", "/v1/admin/sandbox-orgs")
  assert.ok(list(field(listed.body, "sandboxes")).some((entry) => entry.id === field(sandbox, "id")))
})
