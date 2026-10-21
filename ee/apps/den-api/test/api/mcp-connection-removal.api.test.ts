/**
 * Removing an organization connection through OpenWork Connect
 * (removeMcpConnection): discoverable only with the rollout, the same
 * permissions as the dashboard, the exact connection named and confirmed,
 * plugin dependencies refused unless the user agreed, credentials cleaned up,
 * and the connection gone from later listings.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, startFakeMcpServer, summary, text, type McpToolResult, type Member } from "./harness.js"

const den = await bootDen()
const service = await startFakeMcpServer({ tools: [{ name: "list_projects", description: "List projects", text: "projects" }] })
after(async () => { await service.close(); await den.close() })
const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("connection removal tests need MySQL")

const { orgId, owner } = await den.createOrg(await den.signUp("Removal Owner"), "Connection removal")
const teammate = await den.newMember(owner, orgId, "Removal Teammate")
const ownerApi = den.as(owner, orgId)
const ownerToken = await den.mintMcpToken(owner, orgId)
const teammateToken = await den.mintMcpToken(teammate, orgId)

/** Owners add a shared-key connection for everyone; members add a no-sign-in one for themselves. */
async function addConnection(person: Member, name: string): Promise<string> {
  const created = await den.as(person, orgId)("POST", "/v1/mcp-connections", person === owner
    ? { name, url: `${service.url}/mcp`, authType: "apikey", credentialMode: "shared", apiKey: `key-for-${name.toLowerCase().replace(/\W+/g, "-")}`, access: { orgWide: true } }
    : { name, url: `${service.url}/mcp`, authType: "none", credentialMode: "shared", access: { orgWide: false, memberIds: [person.memberId], teamIds: [] } })
  assert.equal(created.status, 200, summary(created))
  return text(field(created.body, "id"), "connection id")
}

async function listedIds(): Promise<string[]> {
  const listed = await ownerApi("GET", "/v1/mcp-connections?scope=manageable")
  assert.equal(listed.status, 200, summary(listed))
  return list(field(listed.body, "connections")).map((row) => String(row.id))
}

async function storedRows(connectionId: string): Promise<{ accounts: number; grants: number; connections: number }> {
  const count = async (sql: string) => {
    const [rows] = await client.query(sql, [connectionId])
    return Number(list(rows)[0]?.total ?? 0)
  }
  return {
    accounts: await count("SELECT COUNT(*) AS total FROM connected_account WHERE provider_id = ?"),
    grants: await count("SELECT COUNT(*) AS total FROM external_mcp_connection_access_grant WHERE external_mcp_connection_id = ?"),
    connections: await count("SELECT COUNT(*) AS total FROM external_mcp_connection WHERE id = ?"),
  }
}

function matchNames(result: McpToolResult): string[] {
  return list(field(result.body, "matches")).map((entry) => String(entry.name))
}

function remove(token: string, connectionId: string, body: Record<string, unknown>) {
  return den.callMcpTool(token, "execute_capability", { name: "removeMcpConnection", path: { connectionId }, body })
}

test("with the rollout off, agents cannot find or call connection removal", async () => {
  const id = await addConnection(owner, "Rollout Off Tracker")
  const search = await den.callMcpTool(ownerToken, "search_capabilities", { query: "delete connection", limit: 20 })
  assert.equal(search.isError, false, search.raw.slice(0, 400))
  assert.equal(matchNames(search).includes("removeMcpConnection"), false)

  const direct = await ownerApi("POST", `/v1/mcp-connections/${id}/remove`, { confirm: true, expectedName: "Rollout Off Tracker" })
  assert.equal(direct.status, 404, summary(direct))
  assert.equal(field(direct.body, "error"), "feature_disabled")
  assert.ok((await listedIds()).includes(id))
})

test("an owner's agent finds removal, removes the exact connection it was asked to, and it is gone with its credentials", async () => {
  const enabled = await den.setFeature(orgId, "agentConnectionRemoval", true)
  assert.equal(enabled.status, 200, summary(enabled))
  const id = await addConnection(owner, "Lab Deploys")
  const before = await storedRows(id)
  assert.equal(before.connections, 1)
  assert.ok(before.grants >= 1, "who can use it is stored before removal")

  const getConnections = await den.callMcpTool(ownerToken, "search_capabilities", { query: "list mcp connections", limit: 20 })
  assert.ok(matchNames(getConnections).includes("getMcpConnections"), getConnections.raw.slice(0, 400))
  for (const query of ["delete connection", "remove connector", "delete MCP connection"]) {
    const search = await den.callMcpTool(ownerToken, "search_capabilities", { query, limit: 20 })
    assert.ok(matchNames(search).includes("removeMcpConnection"), `${query}: ${search.raw.slice(0, 400)}`)
  }

  const unconfirmed = await remove(ownerToken, id, { expectedName: "Lab Deploys" })
  assert.equal(unconfirmed.isError, true, unconfirmed.raw.slice(0, 400))
  const wrongName = await remove(ownerToken, id, { confirm: true, expectedName: "Lab Deploy" })
  assert.equal(wrongName.isError, true, wrongName.raw.slice(0, 400))
  assert.match(wrongName.raw, /connection_name_mismatch/)
  assert.ok((await listedIds()).includes(id), "nothing is removed without confirmation and the exact name")

  const removed = await remove(ownerToken, id, { confirm: true, expectedName: "Lab Deploys" })
  assert.equal(removed.isError, false, removed.raw.slice(0, 400))
  assert.equal(field(removed.body, "ok"), true)
  assert.equal(field(removed.body, "removed", "id"), id)
  assert.equal(field(removed.body, "removed", "name"), "Lab Deploys")
  assert.equal(field(removed.body, "listed"), false)
  assert.equal((await listedIds()).includes(id), false)
  assert.deepEqual(await storedRows(id), { accounts: 0, grants: 0, connections: 0 })

  const again = await remove(ownerToken, id, { confirm: true, expectedName: "Lab Deploys" })
  assert.equal(again.isError, true, again.raw.slice(0, 400))
  assert.match(again.raw, /connection_not_found/)
})

test("a member cannot remove a connection someone else added, but can remove their own", async () => {
  const ownersId = await addConnection(owner, "Owner Billing")
  const denied = await remove(teammateToken, ownersId, { confirm: true, expectedName: "Owner Billing" })
  assert.equal(denied.isError, true, denied.raw.slice(0, 400))
  assert.match(denied.raw, /forbidden/)
  assert.ok((await listedIds()).includes(ownersId))

  const teammatesId = await addConnection(teammate, "Teammate Notes")
  const own = await remove(teammateToken, teammatesId, { confirm: true, expectedName: "Teammate Notes" })
  assert.equal(own.isError, false, own.raw.slice(0, 400))
  assert.equal((await listedIds()).includes(teammatesId), false)
})

test("an unknown connection is reported missing and nothing else is touched", async () => {
  const before = await listedIds()
  const missing = await remove(ownerToken, createDenTypeId("externalMcpConnection"), { confirm: true, expectedName: "Ghost" })
  assert.equal(missing.isError, true, missing.raw.slice(0, 400))
  assert.match(missing.raw, /connection_not_found/)
  assert.deepEqual(await listedIds(), before)
})

test("a connection a plugin needs is kept until the user agrees to remove it from that plugin", async () => {
  const id = await addConnection(owner, "Plugin Tracker")
  const plugin = await ownerApi("POST", "/v1/plugins", { name: `Tracker Plugin ${den.stamp}` })
  assert.equal(plugin.status, 201, summary(plugin))
  const pluginId = text(field(plugin.body, "item", "id"), "plugin id")
  // ARRANGE ONLY: bind the plugin's declared MCP server to this connection, as configuring the plugin's requirement does.
  await client.query(
    "INSERT INTO plugin_mcp_requirement_binding (id, organization_id, plugin_id, config_object_id, server_name, external_mcp_connection_id, created_by_org_membership_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [createDenTypeId("pluginMcpRequirementBinding"), orgId, pluginId, createDenTypeId("configObject"), "tracker", id, owner.memberId],
  )

  const blocked = await remove(ownerToken, id, { confirm: true, expectedName: "Plugin Tracker" })
  assert.equal(blocked.isError, true, blocked.raw.slice(0, 400))
  assert.match(blocked.raw, /connection_in_use/)
  assert.ok(blocked.raw.includes(`Tracker Plugin ${den.stamp}`), "the error names the plugin that needs it")
  assert.ok((await listedIds()).includes(id))

  const detached = await remove(ownerToken, id, { confirm: true, expectedName: "Plugin Tracker", detachFromPlugins: true })
  assert.equal(detached.isError, false, detached.raw.slice(0, 400))
  assert.deepEqual(list(field(detached.body, "detachedFromPlugins")).map((entry) => entry.pluginId), [pluginId])
  assert.equal((await listedIds()).includes(id), false)
  const [bindings] = await client.query("SELECT COUNT(*) AS total FROM plugin_mcp_requirement_binding WHERE external_mcp_connection_id = ?", [id])
  assert.equal(Number(list(bindings)[0]?.total), 0)
})

test("the dashboard's delete route is unchanged and still not offered to agents", async () => {
  const id = await addConnection(owner, "Dashboard Delete")
  const search = await den.callMcpTool(ownerToken, "search_capabilities", { query: "deleteMcpConnectionsByConnectionId", limit: 20 })
  assert.equal(matchNames(search).some((name) => name.startsWith("deleteMcpConnections")), false)
  const deleted = await ownerApi("DELETE", `/v1/mcp-connections/${id}`)
  assert.equal(deleted.status, 200, summary(deleted))
  assert.equal((await listedIds()).includes(id), false)
})
