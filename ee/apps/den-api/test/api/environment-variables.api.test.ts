/**
 * Organization environment variables: an admin assigns them to everyone, teams
 * or people, each assignment with its own value, or lets each person set their
 * own. People choose between assignments that give them a value. Agents may
 * write values (with explicit confirmation) but never read them; only the
 * desktop receives values. Every change is audited without values.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text } from "./harness.js"

// Audit capture on, so the test proves every change is recorded without values.
const den = await bootDen({ env: { DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(() => den.close())

function resolved(body: unknown, key: string) {
  const entry = list(field(body, "environmentVariables")).find((variable) => variable.key === key)
  return entry ? { value: entry.value, source: entry.source, editable: entry.editable } : undefined
}

function entryFor(body: unknown, key: string) {
  return list(field(body, "environmentVariables")).find((variable) => variable.key === key)
}

test("assignments carry their own values and each person gets the most specific one, or the one they choose", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Erin Owner"), "Env org")
  const dana = await den.newMember(owner, orgId, "Dana Designer")
  const sam = await den.newMember(owner, orgId, "Sam Sales")
  const outsider = await den.newMember(owner, orgId, "Olly Outsider")
  const design = await den.createTeam(owner, orgId, "Design", [dana.memberId])
  const asOwner = den.as(owner, orgId)
  const asDana = den.as(dana, orgId)
  const asSam = den.as(sam, orgId)
  const asOutsider = den.as(outsider, orgId)

  const off = await asOwner("GET", "/v1/environment-variables")
  assert.equal(off.status, 404, summary(off))
  assert.equal((await den.setFeature(orgId, "environmentVariables", true)).status < 300, true)

  assert.equal((await asDana("GET", "/v1/environment-variables")).status, 403)
  assert.equal((await asDana("POST", "/v1/environment-variables", { name: "X", key: "X_KEY", valueMode: "admin", assignments: [{ type: "everyone" }] })).status, 403)
  assert.equal((await asOwner("POST", "/v1/environment-variables", { name: "Path", key: "PATH", valueMode: "admin" })).status, 400)

  const workspace = await asOwner("POST", "/v1/environment-variables", {
    name: "Workspace", key: "WORKSPACE_ID", valueMode: "admin",
    assignments: [
      { type: "everyone", value: "default-workspace" },
      { type: "team", teamId: design, value: "design-workspace" },
      { type: "member", orgMembershipId: dana.memberId, value: "dana-workspace" },
    ],
  })
  assert.equal(workspace.status, 201, summary(workspace))
  assert.equal(workspace.text.includes("workspace\"") || workspace.text.includes("dana-workspace"), false, "admin responses never carry values")
  assert.deepEqual(list(field(workspace.body, "environmentVariable", "assignments")).map((entry) => [entry.type, entry.hasValue]), [["everyone", true], ["team", true], ["member", true]])
  const workspaceId = text(field(workspace.body, "environmentVariable", "id"), "workspace id")
  assert.equal((await asOwner("POST", "/v1/environment-variables", { name: "Again", key: "WORKSPACE_ID", valueMode: "admin" })).status, 409)

  // Dana gets the value assigned directly to her; Sam gets everyone's.
  assert.deepEqual(resolved((await asDana("GET", "/v1/environment-variables/resolved")).body, "WORKSPACE_ID"), { value: "dana-workspace", source: "direct", editable: false })
  assert.deepEqual(resolved((await asSam("GET", "/v1/environment-variables/resolved")).body, "WORKSPACE_ID"), { value: "default-workspace", source: "everyone", editable: false })

  // Dana sees her choices by name, never their values, and picks her team's.
  const mine = await asDana("GET", "/v1/environment-variables/mine")
  const options = list(field(entryFor(mine.body, "WORKSPACE_ID"), "assignments"))
  assert.deepEqual(options.map((entry) => entry.label), ["Directly to you", "Design", "Everyone in Env org"])
  assert.equal(mine.text.includes("design-workspace"), false)
  const designOption = text(options.find((entry) => entry.label === "Design")?.accessId, "design access id")
  assert.equal((await asDana("PUT", `/v1/environment-variables/${workspaceId}/my-assignment`, { accessId: designOption })).status, 200)
  assert.deepEqual(resolved((await asDana("GET", "/v1/environment-variables/resolved")).body, "WORKSPACE_ID"), { value: "design-workspace", source: "team", editable: false })
  // Sam can't pick an assignment that doesn't reach him.
  assert.equal((await asSam("PUT", `/v1/environment-variables/${workspaceId}/my-assignment`, { accessId: designOption })).status, 400)

  // Each person sets their own value; admins never set it and never see it.
  const personal = await asOwner("POST", "/v1/environment-variables", {
    name: "Personal token", key: "PERSONAL_TOKEN", valueMode: "per_member",
    assignments: [{ type: "member", orgMembershipId: dana.memberId, value: "ignored" }, { type: "member", orgMembershipId: sam.memberId }],
  })
  assert.equal(personal.status, 201, summary(personal))
  assert.equal(list(field(personal.body, "environmentVariable", "assignments")).some((entry) => entry.hasValue), false)
  const personalId = text(field(personal.body, "environmentVariable", "id"), "personal id")
  assert.equal((await asDana("PUT", `/v1/environment-variables/${personalId}/my-value`, { value: "dana-secret" })).status, 200)
  assert.equal((await asDana("PUT", `/v1/environment-variables/${workspaceId}/my-value`, { value: "override" })).status, 403)
  assert.equal((await asOutsider("PUT", `/v1/environment-variables/${personalId}/my-value`, { value: "nope" })).status, 403)
  assert.deepEqual(resolved((await asDana("GET", "/v1/environment-variables/resolved")).body, "PERSONAL_TOKEN"), { value: "dana-secret", source: "own", editable: true })
  const samResolved = await asSam("GET", "/v1/environment-variables/resolved")
  assert.deepEqual(resolved(samResolved.body, "PERSONAL_TOKEN"), { value: null, source: null, editable: true })
  assert.equal(samResolved.text.includes("dana-secret"), false)
  assert.equal(resolved((await asOutsider("GET", "/v1/environment-variables/resolved")).body, "PERSONAL_TOKEN"), undefined)

  // READ ONLY: values are encrypted at rest (enc:v1:), never stored as plaintext.
  const { client } = await import("../../src/db.js")
  assert.ok("getConnection" in client, "needs MySQL mode")
  const [rows] = await client.query(
    "SELECT value FROM environment_variable_access WHERE value IS NOT NULL UNION ALL SELECT value FROM environment_variable_member_setting WHERE value IS NOT NULL",
  )
  const stored = Array.isArray(rows) ? rows.map((row) => (typeof row === "object" && row !== null && "value" in row ? String(row.value) : "")) : []
  assert.ok(stored.length >= 4, `admin and own values are stored (${stored.length})`)
  for (const raw of stored) {
    assert.match(raw, /^enc:v1:/, "every stored value is encrypted")
    for (const plaintext of ["dana-secret", "dana-workspace", "design-workspace", "default-workspace"]) assert.equal(raw.includes(plaintext), false)
  }

  // An assignment left without a value keeps the stored one; removing it takes the variable away.
  const narrowed = await asOwner("PATCH", `/v1/environment-variables/${workspaceId}`, {
    assignments: [{ type: "team", teamId: design }, { type: "member", orgMembershipId: dana.memberId, value: "dana-workspace-2" }],
  })
  assert.equal(narrowed.status, 200, summary(narrowed))
  assert.equal(resolved((await asSam("GET", "/v1/environment-variables/resolved")).body, "WORKSPACE_ID"), undefined)
  assert.deepEqual(resolved((await asDana("GET", "/v1/environment-variables/resolved")).body, "WORKSPACE_ID"), { value: "design-workspace", source: "team", editable: false })

  // Switching to per-member removes admin values.
  const switched = await asOwner("PATCH", `/v1/environment-variables/${workspaceId}`, { valueMode: "per_member" })
  assert.equal(switched.status, 200, summary(switched))
  assert.deepEqual(resolved((await asDana("GET", "/v1/environment-variables/resolved")).body, "WORKSPACE_ID"), { value: null, source: null, editable: true })

  assert.equal((await asOwner("DELETE", `/v1/environment-variables/${personalId}`)).status, 204)
  assert.equal(resolved((await asDana("GET", "/v1/environment-variables/resolved")).body, "PERSONAL_TOKEN"), undefined)

  // Every change is in the audit log, never a value.
  const operations = await asOwner("GET", "/v1/audit/operations?limit=100")
  assert.equal(operations.status, 200, summary(operations))
  for (const action of ["environment_variable.created", "environment_variable.updated", "environment_variable.deleted", "environment_variable.own_value_set", "environment_variable.assignment_selected"]) {
    // Capture is asynchronous: poll the owner's history for each action.
    const deadline = Date.now() + 15_000
    let found = false
    while (!found && Date.now() < deadline) {
      const listed = await asOwner("GET", `/v1/audit/operations?limit=50&action=${encodeURIComponent(action)}`)
      found = list(field(listed.body, "operations")).length > 0
      if (!found) await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.ok(found, `audit records ${action}`)
  }
  for (const secret of ["dana-secret", "dana-workspace", "design-workspace", "default-workspace"]) {
    assert.equal(operations.text.includes(secret), false, `audit never carries ${secret}`)
    assert.equal((await den.auditStorageText()).includes(secret), false, `audit storage never holds ${secret}`)
  }
})

test("agents set values only after confirming and never read them", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Mia Owner"), "Env agents org")
  const ravi = await den.newMember(owner, orgId, "Ravi Remote")
  assert.equal((await den.setFeature(orgId, "environmentVariables", true)).status < 300, true)
  const ownerToken = await den.mintMcpToken(owner, orgId)
  const raviToken = await den.mintMcpToken(ravi, orgId)

  // An admin's agent creates a variable with a value.
  const created = await den.callMcpTool(ownerToken, "execute_capability", {
    name: "postEnvironmentVariables",
    body: { name: "Company API", key: "COMPANY_API_URL", valueMode: "admin", assignments: [{ type: "everyone", value: "https://api.example.test" }] },
  })
  assert.equal(created.isError, false, created.raw.slice(0, 400))
  const companyId = text(field(created.body, "environmentVariable", "id"), "company id")
  assert.deepEqual(resolved((await den.as(ravi, orgId)("GET", "/v1/environment-variables/resolved")).body, "COMPANY_API_URL"), { value: "https://api.example.test", source: "everyone", editable: false })

  // Replacing it needs the person's agreement.
  const replace = { name: "patchEnvironmentVariables", path: { environmentVariableId: companyId }, body: { assignments: [{ type: "everyone", value: "https://new.example.test" }] } }
  const unconfirmed = await den.callMcpTool(ownerToken, "execute_capability", replace)
  assert.equal(unconfirmed.isError, true)
  assert.equal(field(unconfirmed.body, "error"), "confirmation_required")
  const confirmed = await den.callMcpTool(ownerToken, "execute_capability", { ...replace, body: { ...replace.body, replaceExisting: true } })
  assert.equal(confirmed.isError, false, confirmed.raw.slice(0, 400))

  // A member's agent sets the member's own value, confirming first and again to replace it.
  const personal = await den.as(owner, orgId)("POST", "/v1/environment-variables", { name: "Ravi's token", key: "RAVI_TOKEN", valueMode: "per_member", assignments: [{ type: "everyone" }] })
  const personalId = text(field(personal.body, "environmentVariable", "id"), "personal id")
  const set = (body: Record<string, unknown>) => den.callMcpTool(raviToken, "execute_capability", { name: "putEnvironmentVariablesMyValue", path: { environmentVariableId: personalId }, body })
  assert.equal(field((await set({ value: "first" })).body, "error"), "invalid_request")
  assert.equal((await set({ value: "first", confirmed: true })).isError, false)
  const again = await set({ value: "second", confirmed: true })
  assert.equal(field(again.body, "error"), "confirmation_required")
  assert.equal((await set({ value: "second", confirmed: true, replaceExisting: true })).isError, false)
  assert.deepEqual(resolved((await den.as(ravi, orgId)("GET", "/v1/environment-variables/resolved")).body, "RAVI_TOKEN"), { value: "second", source: "own", editable: true })

  // Agents list names, never values, and can't resolve values at all.
  const listed = await den.callMcpTool(raviToken, "execute_capability", { name: "getEnvironmentVariablesMine" })
  assert.equal(listed.isError, false, listed.raw.slice(0, 400))
  assert.equal(listed.raw.includes("second") || listed.raw.includes("new.example.test"), false)
  const read = await den.callMcpTool(raviToken, "execute_capability", { name: "getEnvironmentVariablesResolved" })
  assert.equal(read.isError, true)
  assert.equal(read.raw.includes("second"), false)

  // The private-field prompt is still available.
  const asked = await den.callMcpTool(raviToken, "execute_capability", { name: "postEnvironmentVariablesValuePrompt", path: { environmentVariableId: personalId }, body: {} })
  assert.deepEqual(field(asked.body, "credentialPrompt", "target"), { type: "environment_variable_member_value", environmentVariableId: personalId, key: "RAVI_TOKEN" })
})

test("admins hold the environment variable permissions by default; members don't", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Pat Owner"), "Env permissions org")
  const admin = await den.newMember(owner, orgId, "Ada Admin", "admin")
  const member = await den.newMember(owner, orgId, "Max Member")
  assert.equal((await den.setFeature(orgId, "environmentVariables", true)).status < 300, true)

  const catalog = await den.as(member, orgId)("GET", "/v1/permissions/catalog")
  assert.equal(catalog.status, 200, summary(catalog))
  for (const key of ["environment_variables.view", "environment_variables.manage"]) {
    assert.ok(catalog.text.includes(key), `catalog lists ${key}`)
  }
  assert.ok(catalog.text.includes("Environment variables"), "catalog lists the Environment variables area")

  const asAdmin = den.as(admin, orgId)
  assert.equal((await asAdmin("GET", "/v1/environment-variables")).status, 200)
  const created = await asAdmin("POST", "/v1/environment-variables", { name: "Region", key: "DEFAULT_REGION", valueMode: "admin", assignments: [{ type: "everyone", value: "eu-west-1" }] })
  assert.equal(created.status, 201, summary(created))

  const asMember = den.as(member, orgId)
  assert.equal((await asMember("GET", "/v1/environment-variables")).status, 403)
  assert.equal((await asMember("POST", "/v1/environment-variables", { name: "X", key: "X_KEY", valueMode: "admin" })).status, 403)
  // Members still see and use what's deployed to them.
  assert.equal((await asMember("GET", "/v1/environment-variables/mine")).status, 200)
})
