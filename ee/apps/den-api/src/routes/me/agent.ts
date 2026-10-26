import { isValidTimeZone } from "@openwork/automations/proactive"
import {
  AGENT_RESPONSIBILITIES,
  AGENT_RESPONSIBILITY_COPY,
  memberAgentInputSchema,
  memberAgentViewSchema,
  type MemberAgentView,
  type WorkbotProactiveSettings,
} from "@openwork/types/den/workbot-proactive"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, type OrganizationContextVariables } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import { listAgentDestinations, readProactiveSettings } from "../../workbot-proactive/access.js"
import { memberAgentOn, memberChoiceChange, memberDestination, mutedOf, type MemberChoices } from "../../workbot-proactive/policy.js"
import { readAgentInstance, saveMemberChoices } from "../../workbot-proactive/repository.js"
import { readAgentTemplate } from "../../workbot-proactive/template.js"
import { workbotOrigin } from "../../workbot/config.js"

/**
 * A member's own agent, as settings: what it will tell them about, and their controls in plain words ("stop telling
 * me about calendar changes", "snooze until tomorrow", "turn it off"). Exposed through Connect, so the member can
 * say it to Workbot; a background agent's read-scoped token can read it but never change it.
 */

const memberAgentDocumentSchema = memberAgentViewSchema.meta({ ref: "MemberAgent" })
const memberAgentInputDocumentSchema = memberAgentInputSchema.meta({ ref: "MemberAgentInput" })
const featureDisabledSchema = z.object({ error: z.literal("feature_disabled"), feature: z.string() }).meta({ ref: "MemberAgentDisabled" })
const unknownDestinationSchema = z.object({ error: z.literal("unknown_destination"), message: z.string() }).meta({ ref: "MemberAgentUnknownDestinationError" })

async function memberAgentView(input: {
  organizationId: DenTypeId<"organization">
  settings: WorkbotProactiveSettings
  row: (MemberChoices & { nextWakeAt: Date | null }) | null
}): Promise<MemberAgentView> {
  const { settings, row } = input
  const template = await readAgentTemplate(input.organizationId)
  const muted = mutedOf(row)
  const chosen = memberDestination(row, settings)
  const name = chosen ? (await listAgentDestinations(input.organizationId)).find((option) => option.connectionId === chosen.destination.connectionId)?.name ?? null : null
  const on = memberAgentOn(row, settings)
  return {
    available: settings.enabled,
    on,
    snoozedUntil: row?.snoozedUntil && row.snoozedUntil.getTime() > Date.now() ? row.snoozedUntil.toISOString() : null,
    responsibilities: AGENT_RESPONSIBILITIES.map((id) => ({ id, ...AGENT_RESPONSIBILITY_COPY[id], enabled: template.responsibilities[id], muted: muted.has(id) })),
    destination: chosen && name ? { connectionId: chosen.destination.connectionId, name, channel: chosen.destination.channel ?? null, chosenBy: chosen.chosenBy } : null,
    workingHours: { workingDays: settings.workingDays, startHour: settings.startHour, endHour: settings.endHour, dailyCap: settings.dailyCap },
    nextCheckAt: settings.enabled && on && row?.nextWakeAt ? row.nextWakeAt.toISOString() : null,
  }
}

export function registerMeAgentRoutes<T extends { Variables: AuthContextVariables & Partial<OrganizationContextVariables> }>(app: Hono<T>) {
  app.get(
    "/v1/me/agent",
    describeRoute({
      tags: ["Users"],
      summary: "Get my agent",
      description:
        "The signed-in member's own agent in the active organization: whether it is on for them, what it will tell them about (each responsibility, whether the organization turned it on and whether they muted it), where its messages go, the working hours and daily limit it follows, and when it looks next. Requires the workbotProactive feature and Workbot on this deployment.",
      responses: {
        200: jsonResponse("The member's agent.", memberAgentDocumentSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Agents are off for this organization.", featureDisabledSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotProactive"),
    async (c) => {
      const context = c.get("organizationContext")
      if (!context || workbotOrigin() === null) return c.json({ error: "feature_disabled" as const, feature: "workbot" }, 404)
      c.header("Cache-Control", "no-store")
      const organizationId = context.organization.id
      return c.json(await memberAgentView({ organizationId, settings: await readProactiveSettings(organizationId), row: await readAgentInstance(context.currentMember.id) }))
    },
  )

  app.put(
    "/v1/me/agent",
    describeRoute({
      tags: ["Users"],
      summary: "Change my agent",
      description:
        "Changes the signed-in member's own agent, as they would say it: turn it on or off (`on`), snooze it until the next working morning or resume (`snooze: \"tomorrow\"` or null), stop or restart one kind of message (`mute` / `unmute`: morning_brief, meeting_prep, calendar_changes, waiting_on_you), or send messages somewhere else (`destination`: a Slack connection, optionally a Slack conversation id; null goes back to the organization's default). Organization settings and limits still apply. Requires the workbotProactive feature and Workbot on this deployment.",
      responses: {
        200: jsonResponse("The member's agent after the change.", memberAgentDocumentSchema),
        400: jsonResponse("The request was invalid, or the destination is not a Slack connection.", z.union([unknownDestinationSchema, invalidRequestSchema])),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Agents are off for this organization.", featureDisabledSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotProactive"),
    jsonValidator(memberAgentInputDocumentSchema),
    async (c) => {
      const context = c.get("organizationContext")
      if (!context || workbotOrigin() === null) return c.json({ error: "feature_disabled" as const, feature: "workbot" }, 404)
      c.header("Cache-Control", "no-store")
      const organizationId = context.organization.id
      const memberId = context.currentMember.id
      const input = c.req.valid("json")
      if (input.destination && !(await listAgentDestinations(organizationId)).some((option) => option.connectionId === input.destination?.connectionId)) {
        return c.json({ error: "unknown_destination" as const, message: "Choose a Slack connection you have connected." }, 400)
      }
      const settings = await readProactiveSettings(organizationId)
      const row = await readAgentInstance(memberId)
      const timeZone = row && isValidTimeZone(row.timeZone) ? row.timeZone : "UTC"
      await saveMemberChoices(organizationId, memberId, memberChoiceChange(input, row, settings, Date.now(), timeZone))
      return c.json(await memberAgentView({ organizationId, settings, row: await readAgentInstance(memberId) }))
    },
  )
}
