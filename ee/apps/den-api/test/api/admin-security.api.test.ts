/**
 * The platform admin Security page reads real tables: new accounts and their first sign-in
 * network, disposable inboxes, the admin allowlist and the tenantless request log. Only
 * platform admins can read either report, and neither returns a full sign-in address.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, summary, type Call } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("Security fixtures require the disposable MySQL harness")
const query = (statement: string, values: (string | number | null)[] = []) => client.execute(statement, values)
const { securityReportResponseSchema, securityRequestsResponseSchema } = await import("../../src/routes/admin/security.js")

const admin = await den.signUp("Platform Admin", process.env.DEN_BOOTSTRAP_ADMIN_EMAILS)
const person = await den.signUp("Regular Person")

// Six accounts open from one network; one more uses a throwaway inbox.
const burst = await Promise.all(Array.from({ length: 6 }, (_, index) => den.signUp(`Burst ${index}`, `burst${index}+${den.stamp}@example.test`)))
for (const [index, account] of burst.entries()) {
  await query("UPDATE session SET ip_address = ? WHERE user_id = ?", [`203.0.113.${10 + index}`, account.userId])
}
const throwaway = await den.signUp("Throwaway")
await query("UPDATE user SET email = ? WHERE id = ?", [`throwaway+${den.stamp}@mailinator.com`, throwaway.userId])

// A burst of failed sign-ins this hour against a quiet day.
const hourStart = Math.floor(Date.now() / 3_600_000) * 3_600_000
for (let index = 0; index < 120; index += 1) {
  await query(
    "INSERT INTO platform_audit_event (id, occurred_at, method, route, action, outcome, status, reason_code, actor_type, origin) VALUES (?, ?, 'POST', '/api/auth/sign-in/email', 'auth.sign_in.email.attempted', 'denied', 401, 'request_denied', 'unknown', 'api')",
    [createDenTypeId("platformAuditEvent"), new Date(hourStart + index * 1_000)],
  )
}

function ok(response: Call) {
  assert.equal(response.status, 200, summary(response))
  assert.equal(response.headers.get("cache-control"), "no-store")
  return response.body
}

test("only platform admins can read security signals", async () => {
  for (const path of ["/v1/admin/security", "/v1/admin/security/requests"]) {
    assert.equal((await den.request(null, "GET", path)).status, 401)
    assert.equal((await den.request(person.token, "GET", path)).status, 403)
  }
  assert.equal((await den.request(admin.token, "GET", "/v1/admin/security?days=90")).status, 400)
})

test("account and credential findings come from real rows", async () => {
  const report = securityReportResponseSchema.parse(ok(await den.request(admin.token, "GET", "/v1/admin/security?days=7")))
  const byId = new Map(report.findings.map((finding) => [finding.id, finding]))
  assert.equal(report.range.days, 7)
  assert.equal(report.findings[0]?.severity === "clear", false, "an open finding sorts first")

  const networks = byId.get("signup-networks")
  assert.equal(networks?.severity, "medium")
  assert.deepEqual(networks?.entities.map((entity) => [entity.label, entity.value]), [["203.0.113.0/24", 6]])
  assert.doesNotMatch(JSON.stringify(report), /203\.0\.113\.1\d/, "full sign-in addresses never leave the server")

  const disposable = byId.get("disposable-signups")
  assert.equal(disposable?.severity, "low")
  assert.deepEqual(disposable?.entities.map((entity) => entity.label), ["mailinator.com"])

  const admins = byId.get("admin-grants")
  assert.ok(admins?.entities.some((entity) => entity.label === process.env.DEN_BOOTSTRAP_ADMIN_EMAILS), "the newly seeded admin is listed")

  for (const id of ["unverified-signups", "unverified-domains", "network-spread", "organization-creation", "api-keys", "client-registrations", "invitations", "spend-spikes"]) {
    assert.ok(byId.has(id), `${id} is always reported`)
  }
})

test("request activity shows the failed sign-in burst by hour", async () => {
  const requests = securityRequestsResponseSchema.parse(ok(await den.request(admin.token, "GET", "/v1/admin/security/requests")))
  assert.equal(requests.hourly.length, 24)
  const current = requests.hourly.at(-1)
  assert.equal(current?.hour, new Date(hourStart).toISOString())
  assert.ok((current?.failedSignIns ?? 0) >= 120)
  const signIns = requests.findings.find((finding) => finding.id === "failed-sign-ins")
  assert.equal(signIns?.severity, "high")
  assert.ok(requests.endpoints.some((endpoint) => endpoint.action === "auth.sign_in.email.attempted" && endpoint.refused >= 120))
})
