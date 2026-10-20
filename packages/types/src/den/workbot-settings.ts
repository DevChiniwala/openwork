import { z } from "zod"

/**
 * Organization settings for Workbot (Den › Manage › Workbot), available while the `workbot` feature is on.
 *
 * The model is the organization's default for its cloud agents: Workbot, the Slack assistant, and cloud Automations
 * set to the cloud default. It is a headless runner model id (the runner's `GET /v1/models`); null means the runner's
 * default. It is kept in the organization's metadata under `workbot.model`, next to the brand name Workbot already
 * reads there. One organization-wide value for now; per-team overrides can be layered on top of it later.
 */

export const WORKBOT_DEFAULT_MODEL_ID = "openai/gpt-6-luna"
export const WORKBOT_DEFAULT_MODEL_NAME = "GPT-6 Luna"

/** Resolve only an exact Luna identity from the runner's own authorized route; never guess another provider. */
export function workbotLunaAlias(catalog: { defaultModel: string; models: { id: string; name: string }[] }): string | null {
  const candidates = catalog.models.filter((model) => model.id === WORKBOT_DEFAULT_MODEL_ID || model.name === WORKBOT_DEFAULT_MODEL_NAME || model.name === `OpenWork: ${WORKBOT_DEFAULT_MODEL_NAME}`)
  const canonical = candidates.find((model) => model.id === WORKBOT_DEFAULT_MODEL_ID)
  if (canonical) return canonical.id
  const configured = candidates.find((model) => model.id === catalog.defaultModel)
  if (configured) return configured.id
  return candidates.length === 1 ? candidates[0]?.id ?? null : null
}

export const workbotModelOptionSchema = z.object({ id: z.string(), name: z.string(), provider: z.string().optional() })
export type WorkbotModelOption = z.infer<typeof workbotModelOptionSchema>

export const workbotSettingsSchema = z.object({
  /** The model the admin chose; null uses the explicit Luna default for Workbot. */
  model: z.string().nullable(),
  /** The effective default for Workbot; legacy mode returns the runner's default or null when unreachable. */
  defaultModel: z.string().nullable(),
  /** The models the runner can serve. Empty when the runner can't be reached. */
  models: z.array(workbotModelOptionSchema),
  /** False when a saved model is no longer offered. The explicit Luna rollout refuses new Workbot turns instead of falling back. */
  modelAvailable: z.boolean(),
  /** The runner answered; when false, the model list is unknown. */
  runnerReachable: z.boolean(),
  /** The catalog is scoped to this member's usable AI Gateway assignments, not the deployment runner. */
  gatewayModels: z.boolean().optional(),
  /** Present only during the explicit Luna rollout. Catalog readiness is not a paid completion probe. */
  defaultReadiness: z.enum(["available", "unavailable", "unverified"]).optional(),
})
export type WorkbotSettings = z.infer<typeof workbotSettingsSchema>

/** A paid, synthetic diagnostic result, never a catalog-derived readiness claim. No answer text or credentials. */
export const workbotModelTestSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("answered"), errorCode: z.null(), requestedModel: z.string(), reportedModel: z.string().nullable() }),
  z.strictObject({ status: z.literal("failed"), errorCode: z.enum(["model_unavailable", "runner_unavailable", "credentials_unavailable", "authentication_failed", "payment_required", "provider_unavailable", "timed_out", "invalid_response", "busy"]), requestedModel: z.string(), reportedModel: z.null() }),
])
export type WorkbotModelTest = z.infer<typeof workbotModelTestSchema>

/**
 * Whether Workbot can get a model for the organization's members, without naming any provider (`GET /v1/org/workbot-readiness`).
 * With cloudAgentGateway on, every Workbot turn needs an active AI Gateway provider; Den web checks this before sending people
 * to Workbot. A provider existing does not mean every member has a usable model.
 */
export const workbotReadinessSchema = z.object({
  /** cloudAgentGateway is on: Workbot turns get their model through the organization's AI Gateway. */
  gatewayRequired: z.boolean(),
  /** The organization has at least one active AI Gateway provider. Only checked while gatewayRequired is true; false otherwise. */
  hasGatewayProvider: z.boolean(),
})
export type WorkbotReadiness = z.infer<typeof workbotReadinessSchema>

export const workbotSettingsInputSchema = z.strictObject({
  /** A model id from `models`, or null for the runner's default. */
  model: z.string().trim().min(1).max(255).nullable(),
})
export type WorkbotSettingsInput = z.infer<typeof workbotSettingsInputSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function metadataRecord(metadata: unknown): Record<string, unknown> {
  if (typeof metadata !== "string") return isRecord(metadata) ? metadata : {}
  try {
    const parsed: unknown = JSON.parse(metadata)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** The organization's default model for its cloud agents, or null for the runner's default. */
export function readWorkbotModel(metadata: unknown): string | null {
  const workbot = metadataRecord(metadata).workbot
  if (!isRecord(workbot)) return null
  const model = workbot.model
  return typeof model === "string" && model.trim() ? model.trim() : null
}

/** Metadata with the default model set (or cleared with null); everything else is kept. */
export function withWorkbotModel(metadata: Record<string, unknown>, model: string | null): Record<string, unknown> {
  const current = metadata.workbot
  const workbot: Record<string, unknown> = { ...(isRecord(current) ? current : {}) }
  if (model) workbot.model = model
  else delete workbot.model
  return { ...metadata, workbot }
}
