import { and, desc, eq, gt, isNull, or, sql } from "@openwork-ee/den-db/drizzle"
import { benefitAccess, freeAutoGrantAllowance, grantUsd, type BenefitGrant, type OrganizationBenefits } from "@openwork-ee/den-db"
import { getOrganizationBenefits } from "../../organization-benefits.js"
import { OrganizationBenefitSettingTable, OrganizationGrantTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { INFERENCE_USAGE_CONVERSION_FACTOR, freeInferenceOrganizationAllowed } from "@openwork/types/den/inference"
import { assertManagedModelsAllowed } from "@openwork/types/den/managed-models-policy"
import { organizationAccessSettingSchema, organizationBenefitSchema, organizationControlPanelSchema, organizationGrantInputSchema, type OrganizationControlPanel, type OrganizationGrant } from "@openwork/types/den/organization-grants"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { adminRoute, jsonValidator, queryValidator } from "../../middleware/index.js"
import { jsonResponse, invalidRequestSchema, notFoundSchema, unauthorizedSchema, forbiddenSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import { organizationFeatureEnabled } from "../../features.js"
import { hasOpenWorkWebComplimentaryAccess, setOpenWorkWebComplimentaryAccess } from "../../openwork-web-access.js"
import { organizationHasOngoingOpenWorkWebSubscription } from "../../stripe-billing.js"
import { auditChangeCapture } from "../../audit/request-capture.js"
import { auditChangeEvent, targetResource } from "../../audit/domain/snapshot.js"
import { logLegacyOrChanges, writeLegacyOrChangesInTx } from "../../audit/domain/legacy.js"
import { ORGANIZATION_AUDIT_ACTIONS } from "../../audit-events.js"

const base = "/v1/admin/organizations/:organizationId/control-panel"
const pageSchema = z.object({ history: z.enum(["0", "1"]).default("0"), offset: z.coerce.number().int().min(0).max(1_000_000).default(0) })
const settingSchema = z.object({ feature: organizationBenefitSchema, setting: organizationAccessSettingSchema }).strict()
const errors = {
  400: jsonResponse("Invalid organization, grant or request.", invalidRequestSchema),
  401: jsonResponse("Sign in required.", unauthorizedSchema),
  403: jsonResponse("Platform administrator required.", forbiddenSchema),
  404: jsonResponse("Organization, grant or rollout not available.", notFoundSchema),
  409: jsonResponse("The request conflicts with an existing grant or paid Web subscription.", z.object({ error: z.string(), message: z.string() })),
}

function autoAccess(metadata: unknown, benefits: OrganizationBenefits) {
  try { assertManagedModelsAllowed(metadata) } catch { return { enabled: false, source: "Blocked by the organization’s managed model policy" } }
  if (!env.inferenceFree.enabled) return { enabled: false, source: "Free Auto is disabled for this deployment" }
  if (!freeInferenceOrganizationAllowed(metadata)) return { enabled: false, source: "Disabled by the organization’s Models setting" }
  const setting = benefits.settings.freeAuto
  return { enabled: benefitAccess(benefits, "freeAuto", true), source: setting === "disabled" ? "Disabled by platform admin" : setting === "enabled" ? "Enabled for this organization; member policies still apply" : "Standard allowance; member policies still apply" }
}

function serializeGrant(grant: BenefitGrant, now: Date, blocked: boolean): OrganizationGrant {
  const state = grant.revokedAt ? "revoked" : grant.startsAt > now ? "scheduled" : grant.expiresAt && grant.expiresAt <= now ? "expired"
    : grant.amount !== null && grant.usedAmount >= grant.amount ? "exhausted" : blocked ? "blocked" : "active"
  return {
    id: grant.id, feature: grant.feature, kind: grant.kind, amountUsd: grant.amount === null ? null : grantUsd(grant.amount),
    usedUsd: grantUsd(grant.usedAmount), remainingUsd: grant.amount === null ? null : grantUsd(Math.max(0, grant.amount - grant.usedAmount)),
    startsAt: grant.startsAt.toISOString(), expiresAt: grant.expiresAt?.toISOString() ?? null, createdAt: grant.createdAt.toISOString(),
    revokedAt: grant.revokedAt?.toISOString() ?? null, createdByUserId: grant.createdByUserId, reason: grant.reason, state,
  }
}

async function panel(organizationId: string, history = false, offset = 0): Promise<OrganizationControlPanel | null> {
  const id = normalizeDenTypeId("organization", organizationId)
  const [org] = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, id)).limit(1)
  if (!org) return null
  const benefits = await getOrganizationBenefits(id)
  const legacyWebAccess = hasOpenWorkWebComplimentaryAccess(org.metadata)
  const auto = autoAccess(org.metadata, benefits)
  const webEnabled = benefitAccess(benefits, "openworkWeb", legacyWebAccess)
  const webSetting = legacyWebAccess && benefits.settings.openworkWeb === "default" ? "enabled" : benefits.settings.openworkWeb
  const webGrants = benefits.grants.filter(grant => grant.feature === "openworkWeb")
  const source = benefits.settings.openworkWeb === "disabled" ? "Complimentary access disabled by platform admin"
    : legacyWebAccess ? "Existing complimentary access; no expiration" : benefits.settings.openworkWeb === "enabled" ? "Enabled for this organization"
      : webGrants.length ? "Enabled by an access grant" : "No complimentary access; paid subscriptions are separate"
  const grants = benefits.enabled ? await db.select().from(OrganizationGrantTable).where(and(
    eq(OrganizationGrantTable.organizationId, id), history ? undefined : and(
      isNull(OrganizationGrantTable.revokedAt), or(isNull(OrganizationGrantTable.expiresAt), gt(OrganizationGrantTable.expiresAt, benefits.now)),
      or(isNull(OrganizationGrantTable.amount), sql`${OrganizationGrantTable.usedAmount} < ${OrganizationGrantTable.amount}`),
    ),
  )).orderBy(desc(OrganizationGrantTable.createdAt), desc(OrganizationGrantTable.id)).limit(51).offset(offset) : []
  const allowance = freeAutoGrantAllowance(benefits)
  return { enabled: benefits.enabled, generatedAt: benefits.now.toISOString(),
    access: { freeAuto: { setting: benefits.settings.freeAuto, ...auto }, openworkWeb: { setting: webSetting, enabled: webEnabled, source } },
    freeAuto: { weeklyLimitUsd: env.inferenceFree.weeklyBudgetUsd, extraRemainingUsd: grantUsd(allowance.remainingAmount), unlimited: allowance.unlimited },
    grants: grants.slice(0, 50).map(grant => serializeGrant(grant, benefits.now, grant.feature === "freeAuto" ? !auto.enabled : !webEnabled)),
    legacyWebAccess, hasMore: grants.length > 50, offset }
}

export function registerAdminOrganizationControlPanelRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get(base, describeRoute({ tags: ["Admin"], summary: "Read an organization's complimentary access and grants", responses: { 200: jsonResponse("Organization control panel.", organizationControlPanelSchema), ...errors } }), adminRoute(), queryValidator(pageSchema), async c => {
    const id = c.req.param("organizationId")
    if (!isDenTypeId("organization", id)) return c.json({ error: "invalid_request", message: "Invalid organization id." }, 400)
    const query = c.req.valid("query")
    const result = await panel(id, query.history === "1", query.offset)
    c.header("Cache-Control", "no-store")
    return result ? c.json(result) : c.json({ error: "not_found", message: "Organization not found." }, 404)
  })

  app.put(`${base}/access`, describeRoute({ tags: ["Admin"], summary: "Set complimentary organization access", responses: { 200: jsonResponse("Access setting saved.", z.object({ ok: z.literal(true) })), ...errors } }), adminRoute(), jsonValidator(settingSchema), async c => {
    const id = c.req.param("organizationId")
    if (!isDenTypeId("organization", id)) return c.json({ error: "invalid_request", message: "Invalid organization id." }, 400)
    if (!await organizationFeatureEnabled(id, "organizationGrants")) return c.json({ error: "feature_disabled", message: "Enable organization grants for this organization first." }, 404)
    const body = c.req.valid("json"), actor = c.get("user").id, capture = auditChangeCapture(c)
    const result = await db.transaction(async tx => {
      const [org] = await tx.select().from(OrganizationTable).where(eq(OrganizationTable.id, id)).limit(1).for("update")
      if (!org) return "missing"
      if (body.feature === "openworkWeb" && body.setting === "enabled" && await organizationHasOngoingOpenWorkWebSubscription(id)) return "subscription"
      const [previous] = await tx.select().from(OrganizationBenefitSettingTable).where(and(eq(OrganizationBenefitSettingTable.organizationId, id), eq(OrganizationBenefitSettingTable.feature, body.feature)))
      if (body.setting === "default") await tx.delete(OrganizationBenefitSettingTable).where(and(eq(OrganizationBenefitSettingTable.organizationId, id), eq(OrganizationBenefitSettingTable.feature, body.feature)))
      else await tx.insert(OrganizationBenefitSettingTable).values({ organizationId: id, feature: body.feature, setting: body.setting, updatedByUserId: actor })
        .onDuplicateKeyUpdate({ set: { setting: body.setting, updatedByUserId: actor, updatedAt: new Date() } })
      const legacy = body.feature === "openworkWeb" && hasOpenWorkWebComplimentaryAccess(org.metadata)
      // A deliberate setting change replaces the legacy complimentary toggle. Its original audit history survives.
      if (legacy) await tx.update(OrganizationTable).set({ metadata: setOpenWorkWebComplimentaryAccess(org.metadata, false) }).where(eq(OrganizationTable.id, id))
      const before = { feature: body.feature, setting: previous?.setting ?? (legacy ? "enabled" : "default"), legacyComplimentaryAccess: legacy }
      const after = { feature: body.feature, setting: body.setting, legacyComplimentaryAccess: false }
      return writeLegacyOrChangesInTx(tx, capture, { organizationId: id, actorUserId: actor, action: ORGANIZATION_AUDIT_ACTIONS.benefitSettingUpdated, payload: { feature: body.feature, setting: body.setting } }, [auditChangeEvent({ action: "organization.benefit_setting.updated", resources: [targetResource("organization", id)], before, after })])
    })
    if (result === "missing") return c.json({ error: "not_found", message: "Organization not found." }, 404)
    if (result === "subscription") return c.json({ error: "openwork_web_subscription_exists", message: "An ongoing paid Web subscription already provides access." }, 409)
    logLegacyOrChanges(capture, result)
    return c.json({ ok: true })
  })

  app.post(`${base}/grants`, describeRoute({ tags: ["Admin"], summary: "Grant organization access or Free Auto usage", description: "Creates an idempotent organization-scoped grant. A null expiry means until spent or revoked; unlimited usage is a separate grant kind. Does not change billing.", responses: { 200: jsonResponse("Grant created or original retry returned.", z.object({ ok: z.literal(true), grantId: z.string() })), ...errors } }), adminRoute(), jsonValidator(organizationGrantInputSchema), async c => {
    const id = c.req.param("organizationId")
    if (!isDenTypeId("organization", id)) return c.json({ error: "invalid_request", message: "Invalid organization id." }, 400)
    if (!await organizationFeatureEnabled(id, "organizationGrants")) return c.json({ error: "feature_disabled", message: "Enable organization grants for this organization first." }, 404)
    const body = c.req.valid("json"), capture = auditChangeCapture(c), actor = c.get("user").id
    const amount = body.amountUsd === null ? null : Math.round(body.amountUsd * INFERENCE_USAGE_CONVERSION_FACTOR)
    const result = await db.transaction(async tx => {
      const [org] = await tx.select({ id: OrganizationTable.id, now: sql<number>`unix_timestamp(current_timestamp(3)) * 1000` }).from(OrganizationTable).where(eq(OrganizationTable.id, id)).limit(1).for("update")
      if (!org) return { error: "missing" }
      const [existing] = await tx.select().from(OrganizationGrantTable).where(and(eq(OrganizationGrantTable.organizationId, id), eq(OrganizationGrantTable.requestId, body.requestId))).limit(1)
      if (existing) {
        const same = existing.feature === body.feature && existing.kind === body.kind && existing.amount === amount && existing.reason === body.reason
          && (existing.expiresAt?.getTime() ?? null) === (body.expiresAt ? Date.parse(body.expiresAt) : null)
          && (!body.startsAt || existing.startsAt.getTime() === Date.parse(body.startsAt))
        return same ? { grantId: existing.id } : { error: "conflict" }
      }
      const now = new Date(Number(org.now)), startsAt = body.startsAt ? new Date(body.startsAt) : now, expiresAt = body.expiresAt ? new Date(body.expiresAt) : null
      if (startsAt.getTime() < now.getTime() - 60_000 || startsAt.getUTCFullYear() > 2037 || (expiresAt && (expiresAt <= startsAt || expiresAt <= now || expiresAt.getUTCFullYear() > 2037))) return { error: "dates" }
      if (body.feature === "openworkWeb" && await organizationHasOngoingOpenWorkWebSubscription(id)) return { error: "subscription" }
      const grantId = createDenTypeId("organizationGrant")
      await tx.insert(OrganizationGrantTable).values({ id: grantId, organizationId: id, requestId: body.requestId, feature: body.feature, kind: body.kind, amount, startsAt, expiresAt, reason: body.reason, createdByUserId: actor })
      const snapshot = { id: grantId, feature: body.feature, kind: body.kind, amountUsd: body.amountUsd, startsAt: startsAt.toISOString(), expiresAt: expiresAt?.toISOString() ?? null }
      const audit = await writeLegacyOrChangesInTx(tx, capture, { organizationId: id, actorUserId: actor, action: ORGANIZATION_AUDIT_ACTIONS.benefitGrantCreated, payload: { grantId, feature: body.feature, kind: body.kind } }, [auditChangeEvent({ action: "organization.benefit_grant.created", resources: [targetResource("organization_grant", grantId)], before: null, after: snapshot, annotations: { reasonProvided: true } })])
      return { grantId, audit }
    })
    if (result.error === "missing") return c.json({ error: "not_found", message: "Organization not found." }, 404)
    if (result.error === "dates") return c.json({ error: "invalid_request", message: "Choose a current or future start and a later expiration before 2038, or no expiration." }, 400)
    if (result.error === "subscription") return c.json({ error: "openwork_web_subscription_exists", message: "An ongoing paid Web subscription already provides access." }, 409)
    if (result.error === "conflict") return c.json({ error: "grant_request_conflict", message: "This request id already created a different grant." }, 409)
    if (result.audit) logLegacyOrChanges(capture, result.audit)
    return c.json({ ok: true, grantId: result.grantId })
  })

  app.post(`${base}/grants/:grantId/revoke`, describeRoute({ tags: ["Admin"], summary: "Revoke an organization grant without removing its history", responses: { 200: jsonResponse("Grant revoked.", z.object({ ok: z.literal(true) })), ...errors } }), adminRoute(), async c => {
    const id = c.req.param("organizationId"), grantId = c.req.param("grantId")
    if (!isDenTypeId("organization", id) || !isDenTypeId("organizationGrant", grantId)) return c.json({ error: "invalid_request", message: "Invalid organization or grant id." }, 400)
    if (!await organizationFeatureEnabled(id, "organizationGrants")) return c.json({ error: "feature_disabled", message: "Enable organization grants for this organization first." }, 404)
    const capture = auditChangeCapture(c), actor = c.get("user").id
    const result = await db.transaction(async tx => {
      const [org] = await tx.select({ id: OrganizationTable.id }).from(OrganizationTable).where(eq(OrganizationTable.id, id)).limit(1).for("update")
      if (!org) return null
      const [grant] = await tx.select().from(OrganizationGrantTable).where(and(eq(OrganizationGrantTable.id, grantId), eq(OrganizationGrantTable.organizationId, id))).limit(1).for("update")
      if (!grant) return null
      if (grant.revokedAt) return "revoked"
      const now = new Date()
      await tx.update(OrganizationGrantTable).set({ revokedAt: now, revokedByUserId: actor }).where(and(eq(OrganizationGrantTable.id, grantId), eq(OrganizationGrantTable.organizationId, id)))
      return writeLegacyOrChangesInTx(tx, capture, { organizationId: id, actorUserId: actor, action: ORGANIZATION_AUDIT_ACTIONS.benefitGrantRevoked, payload: { grantId } }, [auditChangeEvent({ action: "organization.benefit_grant.revoked", resources: [targetResource("organization_grant", grantId)], before: { revokedAt: null }, after: { revokedAt: now.toISOString() } })])
    })
    if (!result) return c.json({ error: "not_found", message: "Grant not found in this organization." }, 404)
    if (result !== "revoked") logLegacyOrChanges(capture, result)
    return c.json({ ok: true })
  })
}
