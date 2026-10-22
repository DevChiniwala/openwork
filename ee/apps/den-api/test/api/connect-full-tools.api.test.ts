/**
 * Connect's full tool view on the real app: it is off unless the organization
 * has connectStandardTools, lists only the connection tools a member is
 * granted and their tool policy allows, and runs a tool through the same
 * executor and Library usage as execute_capability.
 */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, before, test } from "node:test"
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server"
import { bootDen, field, list, startFakeMcpServer, summary, text, type Member } from "./harness.js"

const den = await bootDen()
const PROOF = `status-proof-${randomBytes(6).toString("hex")}`
const service = await startFakeMcpServer({
  tools: [
    { name: "read_status", description: "Read the status page", text: PROOF },
    { name: "reset_status", description: "Reset the status page", text: "reset" },
  ],
})
after(async () => {
  await service.close()
  await den.close()
})

let orgId = ""
let owner: Member
let riley: Member
let rileyToken = ""
let samToken = ""
let connectionId = ""

before(async () => {
  const avery = await den.signUp("Avery Owner")
  const created = await den.createOrg(avery, "Full tools")
  orgId = created.orgId
  owner = created.owner
  riley = await den.newMember(owner, orgId, "Riley Member")
  const sam = await den.newMember(owner, orgId, "Sam Member")
  rileyToken = await den.mintMcpToken(riley, orgId)
  samToken = await den.mintMcpToken(sam, orgId)
  const connection = await den.as(owner, orgId)("POST", "/v1/mcp-connections", {
    name: "Status Board",
    url: `${service.url}/mcp`,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: false, memberIds: [riley.memberId], teamIds: [] },
  })
  assert.equal(connection.status, 200, summary(connection))
  connectionId = text(field(connection.body, "id"), "connection id")
  const policy = await den.as(owner, orgId)("PUT", `/v1/mcp-connections/${connectionId}/tool-policy`, { allDisabled: false, disabledTools: ["reset_status"] })
  assert.equal(policy.status, 200, summary(policy))
})

/** One JSON-RPC request to Connect: 2025-era without clientInfo, 2026-era with it. */
async function rpc(token: string, method: string, params: Record<string, unknown>, options: { query?: string; clientInfo?: { name: string; version: string } } = {}) {
  const modern = options.clientInfo !== undefined
  const response = await den.request(token, "POST", `/mcp/agent${options.query ?? ""}`, {
    headers: {
      accept: "application/json, text/event-stream",
      ...(modern ? {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
      } : {}),
    },
    body: {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: modern
        ? { ...params, _meta: { [PROTOCOL_VERSION_META_KEY]: "2026-07-28", [CLIENT_INFO_META_KEY]: options.clientInfo, [CLIENT_CAPABILITIES_META_KEY]: {} } }
        : params,
    },
  })
  const line = response.text.split("\n").find((entry) => entry.startsWith("data:"))
  const envelope: unknown = line ? JSON.parse(line.slice(5)) : response.body
  return { status: response.status, result: field(envelope, "result"), error: field(envelope, "error") }
}

async function toolNames(token: string, options: Parameters<typeof rpc>[3] = {}): Promise<string[]> {
  const listed = await rpc(token, "tools/list", {}, options)
  assert.equal(listed.status, 200)
  return list(field(listed.result, "tools")).map((tool) => String(tool.name))
}

function resultText(result: unknown): string {
  return list(field(result, "content")).map((part) => String(part.text ?? "")).join("\n")
}

async function connectorUses(): Promise<number> {
  const usage = await den.as(owner, orgId)("GET", `/v1/library-usage?kind=connectors&itemId=${connectionId}`)
  assert.equal(usage.status, 200, summary(usage))
  return list(field(usage.body, "rows")).reduce((total, row) => total + (typeof row.uses === "number" ? row.uses : 0), 0)
}

test("with the flag off, neither the override nor a known client changes Connect's tools", async () => {
  for (const options of [{ query: "?tools=full" }, { clientInfo: { name: "claude-code", version: "2" } }]) {
    const names = await toolNames(rileyToken, options)
    assert.ok(names.includes("search_capabilities") && names.includes("execute_capability"), names.join(","))
    assert.ok(!names.some((name) => name.startsWith("status_board.")))
  }
})

test("with the flag on, the full view lists only granted, enabled tools and runs them like execute_capability", async () => {
  const enabled = await den.setFeature(orgId, "connectStandardTools", true)
  assert.ok(enabled.status < 300, summary(enabled))

  // Claude Code gets the full view; other and 2025-era clients keep search unless they ask.
  const claude = await toolNames(rileyToken, { clientInfo: { name: "claude-code", version: "2" } })
  assert.ok(claude.includes("status_board.read_status"), claude.join(","))
  assert.ok(!claude.includes("status_board.reset_status"), "a tool the policy disables is never listed")
  assert.ok(!claude.includes("search_capabilities") && !claude.includes("execute_capability"))
  assert.ok(claude.includes("connection_status") && claude.includes("get_skill"))
  // OpenWork's own role-gated API stays in the search view, except the key request connection cards name.
  assert.deepEqual(claude.filter((name) => name.startsWith("den.")), ["den.postMcpConnectionsCredentialPrompt"])
  assert.ok((await toolNames(rileyToken, { clientInfo: { name: "cursor", version: "1" } })).includes("search_capabilities"))
  assert.ok((await toolNames(rileyToken)).includes("search_capabilities"))
  assert.deepEqual(await toolNames(rileyToken, { query: "?tools=full" }), claude)
  assert.ok((await toolNames(rileyToken, { query: "?tools=search", clientInfo: { name: "claude-code", version: "2" } })).includes("search_capabilities"))
  const again = await toolNames(rileyToken, { clientInfo: { name: "claude-code", version: "2" } })
  assert.deepEqual(again, claude, "the same request lists the same tools in the same order")

  // A member without a grant never sees or reaches the connection, whatever they ask for.
  const sam = await toolNames(samToken, { query: "?tools=full" })
  assert.ok(!sam.some((name) => name.startsWith("status_board.")), sam.join(","))
  const samCall = await rpc(samToken, "tools/call", { name: "status_board.read_status", arguments: {} }, { query: "?tools=full" })
  assert.ok(samCall.error !== undefined || field(samCall.result, "isError") === true)
  assert.doesNotMatch(JSON.stringify(samCall), new RegExp(PROOF))
  const disabled = await rpc(rileyToken, "tools/call", { name: "status_board.reset_status", arguments: {} }, { query: "?tools=full" })
  assert.ok(disabled.error !== undefined || field(disabled.result, "isError") === true)

  // One call each way: the same provider result and the same Library usage.
  const before = await connectorUses()
  const direct = await rpc(rileyToken, "tools/call", { name: "status_board.read_status", arguments: {} }, { clientInfo: { name: "claude-code", version: "2" } })
  assert.equal(field(direct.result, "isError") === true, false, JSON.stringify(direct))
  assert.equal(resultText(direct.result), PROOF)
  const executed = await rpc(rileyToken, "tools/call", { name: "execute_capability", arguments: { name: `mcp:${connectionId}:read_status`, body: {} } })
  assert.equal(resultText(executed.result), PROOF)
  const deadline = Date.now() + 5_000
  while (await connectorUses() < before + 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(await connectorUses(), before + 2)

  // App building takes full-view names and binds the capability they run.
  const prepared = await rpc(rileyToken, "tools/call", {
    name: "prepare_app",
    arguments: { title: "Status check", tools: [{ name: "read_status", description: "Read the status page", capability: "status_board.read_status" }] },
  }, { clientInfo: { name: "claude-code", version: "2" } })
  assert.notEqual(field(prepared.result, "isError"), true, JSON.stringify(prepared))
  const bound = list(field(prepared.result, "structuredContent", "tools"))
  assert.deepEqual(bound.map((tool) => tool.capability), [`mcp:${connectionId}:read_status`])
})
