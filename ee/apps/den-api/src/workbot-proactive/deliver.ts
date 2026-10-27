import { and, eq } from "@openwork-ee/den-db/drizzle"
import { ExternalMcpConnectionTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { AgentDestination } from "@openwork/types/den/workbot-proactive"
import { toolCallFailed } from "../capability-usage.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE } from "../mcp/scopes.js"
import {
  resolveWorkbotDirectMessageTarget,
  sendWorkbotDirectMessage,
  type WorkbotDirectMessageResult,
  type WorkbotDirectMessageTarget,
} from "../slack-assistant/direct-message.js"

/**
 * Delivery: Den, not the model, sends the message after the delivery policy passed, and the model never picks who
 * gets it.
 * - A Workbot DM (the default): from the Workbot Slack app's own bot, so the member is notified.
 * - A Slack channel the member chose: posted as the member through their Slack connection in Connect
 *   (Slack's MCP server `slack_send_message`).
 */

export const SLACK_SEND_TOOL = "slack_send_message"

export type DeliveryBlock = "slack_app_not_installed" | "member_not_linked" | "connection_unavailable"
export type DeliveryResult = { ok: true } | { ok: false; code: DeliveryBlock | "send_failed" }

export type DestinationConnection = Pick<typeof ExternalMcpConnectionTable.$inferSelect, "id" | "credentialMode" | "authType" | "oauthIssuerReviewRequiredAt" | "url">

/**
 * A Slack connection in Connect: Slack's own MCP server, where each person signs in with their own Slack account.
 * The same rule as the Slack assistant's `isSlackConnection`, kept here so delivery doesn't load the assistant.
 */
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

export type DeliveryDeps = {
  workbotTarget: (input: { organizationId: string; userId: string }) => Promise<WorkbotDirectMessageTarget>
  workbotDm: (input: { organizationId: string; userId: string; text: string }) => Promise<WorkbotDirectMessageResult>
  connection: (organizationId: DenTypeId<"organization">, connectionId: string) => Promise<DestinationConnection | null>
  sendAsMember: (input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user">; connectionId: string; channel: string; text: string }) => Promise<boolean>
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

async function sendThroughConnect(input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user">; connectionId: string; channel: string; text: string }) {
  // Loaded lazily: Connect's modules pull in auth and the MCP gateway.
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
  workbotTarget: (input) => resolveWorkbotDirectMessageTarget(input),
  workbotDm: (input) => sendWorkbotDirectMessage(input),
  connection: readDestinationConnection,
  sendAsMember: sendThroughConnect,
}

/** Whether a message could reach the member now; null when it can, otherwise why not. Sends nothing. */
export async function destinationBlock(
  input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user">; destination: AgentDestination },
  deps: Pick<DeliveryDeps, "workbotTarget" | "connection"> = defaultDeliveryDeps,
): Promise<DeliveryBlock | null> {
  if (input.destination.kind === "workbot_dm") {
    const target = await deps.workbotTarget({ organizationId: input.organizationId, userId: input.userId })
    return target.ok ? null : target.reason
  }
  const connection = await deps.connection(input.organizationId, input.destination.connectionId)
  return connection && isSlackDestination(connection) ? null : "connection_unavailable"
}

export async function deliverAgentMessage(
  input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user">; destination: AgentDestination; text: string },
  deps: DeliveryDeps = defaultDeliveryDeps,
): Promise<DeliveryResult> {
  const destination = input.destination
  if (destination.kind === "workbot_dm") {
    const sent = await deps.workbotDm({ organizationId: input.organizationId, userId: input.userId, text: input.text })
    if (sent.ok) return { ok: true }
    return { ok: false, code: sent.reason === "slack_error" ? "send_failed" : sent.reason }
  }
  const connection = await deps.connection(input.organizationId, destination.connectionId)
  if (!connection || !isSlackDestination(connection)) return { ok: false, code: "connection_unavailable" }
  const sent = await deps
    .sendAsMember({ organizationId: input.organizationId, userId: input.userId, connectionId: connection.id, channel: destination.channel, text: input.text })
    .catch(() => false)
  return sent ? { ok: true } : { ok: false, code: "send_failed" }
}
