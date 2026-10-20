import { and, eq } from "@openwork-ee/den-db/drizzle"
import { GatewayProviderTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { workbotReadinessSchema } from "@openwork/types/den/workbot-settings"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { db } from "../../db.js"
import { orgMemberRoute } from "../../middleware/index.js"
import { jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { cloudAgentGatewayEnabled } from "../../workbot/model.js"
import type { OrgRouteVariables } from "./shared.js"

const workbotReadinessDocumentSchema = workbotReadinessSchema.meta({ ref: "WorkbotReadiness" })

async function hasActiveGatewayProvider(organizationId: string): Promise<boolean> {
  const [provider] = await db.select({ id: GatewayProviderTable.id }).from(GatewayProviderTable)
    .where(and(eq(GatewayProviderTable.organization_id, normalizeDenTypeId("organization", organizationId)), eq(GatewayProviderTable.status, "active")))
    .limit(1)
  return Boolean(provider)
}

/**
 * With cloudAgentGateway on, Den refuses Workbot turns when the organization has no active AI Gateway provider. Members
 * cannot list providers, so Den web reads this content-free answer before sending someone to Workbot.
 */
export function registerOrgWorkbotReadinessRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/org/workbot-readiness",
    describeRoute({
      tags: ["Organizations"],
      summary: "Check whether Workbot has an AI provider",
      description:
        "Returns whether Workbot turns need the organization's AI Gateway (gatewayRequired, true while cloudAgentGateway is on) and, only then, whether the organization has at least one active AI Gateway provider (hasGatewayProvider; false when not required). Content-free: no provider names, counts, ids, models or grants. A provider existing does not mean the caller has a usable model; each turn still checks the member's own access. Available to any organization member. Never exposed to MCP.",
      ...{ "x-mcp": false },
      responses: {
        200: jsonResponse("Whether Workbot needs an AI Gateway provider and whether one exists.", workbotReadinessDocumentSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        404: jsonResponse("The caller is not a member of the organization.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const organizationId = c.get("organizationContext").organization.id
      const gatewayRequired = await cloudAgentGatewayEnabled(organizationId)
      const hasGatewayProvider = gatewayRequired && await hasActiveGatewayProvider(organizationId)
      return c.json({ gatewayRequired, hasGatewayProvider })
    },
  )
}
