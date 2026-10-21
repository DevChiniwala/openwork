import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { AuthContextVariables } from "../src/session.js"

// Hosted Den: deny before any allowlist lookup. No database is contacted.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/operator_authority_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-operator-authority-unit-test-secret-not-production"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-operator-authority-unit-test-key-not-production"
process.env.OPENWORK_DEV_MODE = "1"
process.env.DEN_DEPLOYMENT = "cloud"
const { db } = await import("../src/db.js")
// Better Auth seeds its resource registry on import. Return an already-present
// synthetic registry row while the modules initialize, without SQL I/O.
const bootstrapSelect = mock.method(db, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://api.unit.test/mcp/agent", policyVersion: 1 }] } } },
}))
const { auth } = await import("../src/auth.js")
await auth.$context
bootstrapSelect.mock.restore()
const { canManageDeploymentServices, isLocalDeploymentOperator } = await import("../src/middleware/admin.js")

test("hosted Den never grants installation authority, to sessions or API keys, and never looks up the allowlist", async () => {
  const lookups = mock.method(db, "select", () => { throw new Error("hosted Den must not consult the local allowlist") })
  try {
    const userId = createDenTypeId("user")
    const user = { id: userId, email: "operator@example.test", name: "Operator", emailVerified: true, image: null, createdAt: new Date(), updatedAt: new Date() }
    const apiKey = { id: createDenTypeId("apiKey"), configId: "default", referenceId: userId, metadata: null }
    const session = { id: createDenTypeId("session"), token: "synthetic-session-token", userId, expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date(), ipAddress: null, userAgent: null, activeOrganizationId: null, activeTeamId: null }
    const principals: AuthContextVariables[] = [{ user, session: null, apiKey }, { user, session, apiKey: null }]
    for (const principal of principals) {
      assert.equal(await isLocalDeploymentOperator(principal), false)
      assert.equal(await canManageDeploymentServices(principal), false)
    }
    assert.equal(lookups.mock.callCount(), 0)
  } finally { lookups.mock.restore() }
})
