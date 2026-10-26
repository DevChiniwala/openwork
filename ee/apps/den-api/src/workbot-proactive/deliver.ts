import { and, eq } from "@openwork-ee/den-db/drizzle"
import { ExternalMcpConnectionTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import type { AgentDestination } from "@openwork/types/den/workbot-proactive"
import { toolCallFailed } from "../capability-usage.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE } from "../mcp/scopes.js"
import { slackClient, type SlackCall } from "../slack-assistant/protocol.js"

/**
 * Delivery: Den, not the model, sends the message after the delivery policy passed. A destination is a Connect
 * connection plus a target; Den calls that connection's own send tool as the member, exactly as their agent would
 * through Connect. Slack today: Slack's MCP server `slack_send_message`, which posts as the member, to a channel they
 * chose or to their own DM.
 */

export const SLACK_SEND_TOOL = "slack_send_message"

/**
 * A Slack connection in Connect: Slack's own MCP server, where each person signs in with their own Slack account.
 * The same rule as the Slack assistant's `isSlackConnection`, kept here so delivery doesn't load the assistant.
 */
export type DestinationConnection = Pick<typeof ExternalMcpConnectionTable.$inferSelect, "id" | "credentialMode" | "authType" | "oauthIssuerReviewRequiredAt" | "url">

export function isSlackDestination(connection: Omit<DestinationConnection, "id">) {
  try {
    return connection.credentialMode === "per_member"
      && connection.authType === "oauth"
      && connection.oauthIssuerReviewRequiredAt === null
      && new URL(connection.url).hostname === "mcp.slack.com"
  } catch {
    return false
  }
}

export type SelfChannel = { connectionId: string; channel: string }
export type DeliveryResult = { ok: true; selfChannel: SelfChannel | null } | { ok: false; code: string }

export type DeliveryDeps = {
  connection: (organizationId: DenTypeId<"organization">, connectionId: string) => Promise<DestinationConnection | null>
  /** The member's own Slack user id on this connection: their DM with themselves. */
  selfChannel: (organizationId: DenTypeId<"organization">, connectionId: string, memberId: DenTypeId<"member">) => Promise<string | null>
  send: (input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user">; connectionId: string; channel: string; text: string }) => Promise<boolean>
}

async function readDestinationConnection(organizationId: DenTypeId<"organization">, connectionId: string) {
  if (!isDenTypeId("externalMcpConnection", connectionId)) return null
  const [row] = await db
    .select()
    .from(ExternalMcpConnectionTable)
    .where(and(eq(ExternalMcpConnectionTable.organizationId, organizationId), eq(ExternalMcpConnectionTable.id, connectionId)))
    .limit(1)
  return row ?? null
}

/** `auth.test` with the member's own Slack token (what Den already does when a member connects Slack). Read-only. */
async function resolveSlackSelf(organizationId: DenTypeId<"organization">, connectionId: string, memberId: DenTypeId<"member">, client: (token: string) => SlackCall = slackClient) {
  const connection = await readDestinationConnection(organizationId, connectionId)
  if (!connection) return null
  // Loaded lazily: Connect's modules pull in auth and the MCP gateway.
  const { readConnectedAccountForExternalMcpIdentity } = await import("../capability-sources/external-mcp-connections.js")
  const account = await readConnectedAccountForExternalMcpIdentity({ connection, orgMembershipId: memberId })
  if (!account.current || !account.value?.accessToken) return null
  const parsed = z.object({ user_id: z.string().regex(/^[UW][A-Z0-9]+$/) }).safeParse(await client(account.value.accessToken)("auth.test", {}).catch(() => null))
  return parsed.success ? parsed.data.user_id : null
}

async function sendThroughConnect(input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user">; connectionId: string; channel: string; text: string }) {
  const { executeExternalCapability, resolveMcpMemberIdentity } = await import("../mcp/external-capabilities.js")
  const member = await resolveMcpMemberIdentity({ userId: input.userId, organizationId: input.organizationId })
  if (!member) return false
  const result = await executeExternalCapability({
    organizationId: input.organizationId,
    member,
    // Den's own delivery after policy, never a model's call: the agent's turn only ever had mcp:read.
    scopes: new Set([DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE]),
    connectionId: input.connectionId,
    toolName: SLACK_SEND_TOOL,
    args: { channel_id: input.channel, message: input.text },
    redirectUriBase: env.apiPublicUrl ?? "http://127.0.0.1",
    usageSource: "agent",
  })
  return result.ok && !toolCallFailed(result.result)
}

export const defaultDeliveryDeps: DeliveryDeps = {
  connection: readDestinationConnection,
  selfChannel: (organizationId, connectionId, memberId) => resolveSlackSelf(organizationId, connectionId, memberId),
  send: sendThroughConnect,
}

export async function deliverAgentMessage(
  input: {
    organizationId: DenTypeId<"organization">
    memberId: DenTypeId<"member">
    userId: DenTypeId<"user">
    destination: AgentDestination
    /** The member's DM channel learned earlier, if any. */
    knownSelf: SelfChannel | null
    text: string
  },
  deps: DeliveryDeps = defaultDeliveryDeps,
): Promise<DeliveryResult> {
  const connection = await deps.connection(input.organizationId, input.destination.connectionId)
  if (!connection || !isSlackDestination(connection)) return { ok: false, code: "destination_unavailable" }
  let selfChannel: SelfChannel | null = null
  let channel = input.destination.channel ?? null
  if (!channel) {
    const known = input.knownSelf?.connectionId === connection.id ? input.knownSelf.channel : null
    channel = known ?? (await deps.selfChannel(input.organizationId, connection.id, input.memberId).catch(() => null))
    if (!channel) return { ok: false, code: "destination_unresolved" }
    selfChannel = { connectionId: connection.id, channel }
  }
  const sent = await deps.send({ organizationId: input.organizationId, userId: input.userId, connectionId: connection.id, channel, text: input.text }).catch(() => false)
  return sent ? { ok: true, selfChannel } : { ok: false, code: "send_failed" }
}
