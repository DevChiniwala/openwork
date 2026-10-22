import { AuditLogError, readAuditPolicy, setAuditRetentionDays } from "@openwork-ee/den-db/audit-log"
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { DEFAULT_AUDIT_RETENTION_DAYS, MAX_AUDIT_RETENTION_DAYS, auditRetentionAdminResponseSchema, auditRetentionUpdateSchema, type AuditRetentionAdminResponse } from "@openwork/types/den/audit"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { initializeAuditPolicyInTx, readAuditAvailability } from "../../audit/capture.js"
import { auditRetentionCoveredRoute } from "../../audit/covered-routes.js"
import { currentAuditRequestId } from "../../audit/request-capture.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { organizationFeatureEnabled } from "../../features.js"
import { adminRoute, jsonValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

const path = "/v1/admin/organizations/:organizationId/audit-retention"
const conflictSchema = z.object({ error: z.enum(["audit_policy_changed", "audit_not_entitled", "audit_capture_unavailable"]), message: z.string() })
const errors = {
  400: jsonResponse("Invalid organization id or retention days (1 to 365).", invalidRequestSchema),
  401: jsonResponse("Sign in required.", unauthorizedSchema),
  403: jsonResponse("Platform administrator required.", forbiddenSchema),
  404: jsonResponse("Organization not found.", notFoundSchema),
}
const conflictMessages = {
  audit_policy_changed: "The retention setting changed since it was loaded. Reload and try again.",
  audit_not_entitled: "Audit logs need an Enterprise plan first.",
  audit_capture_unavailable: "Audit capture is turned off for this deployment.",
} satisfies Record<z.infer<typeof conflictSchema>["error"], string>

async function retentionState(organizationId: typeof OrganizationTable.$inferSelect.id): Promise<AuditRetentionAdminResponse | null> {
  const [organization] = await db.select({ id: OrganizationTable.id }).from(OrganizationTable).where(eq(OrganizationTable.id, organizationId)).limit(1)
  if (!organization) return null
  const [{ entitlement }, policy, cleanupEnabled] = await Promise.all([
    readAuditAvailability(db, organizationId), readAuditPolicy(db, organizationId), organizationFeatureEnabled(organizationId, "auditRetentionCleanup"),
  ])
  return auditRetentionAdminResponseSchema.parse({
    organizationId, available: entitlement.enabled, retentionDays: policy?.retentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS,
    defaultRetentionDays: DEFAULT_AUDIT_RETENTION_DAYS, maximumRetentionDays: MAX_AUDIT_RETENTION_DAYS,
    revision: policy?.revision ?? null, cleanupEnabled: cleanupEnabled && policy?.excessMode !== "keep_all",
  })
}

export function registerAdminAuditRetentionRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get(path, describeRoute({ tags: ["Admin"], summary: "Read an organization's audit log retention", description: "Returns how many days audit history is kept for the organization (90 by default, at most 365), the policy revision to send with a change, and whether age-based cleanup is on for it. Without a policy the default is shown and revision is null. Platform administrators only.", responses: { 200: jsonResponse("Audit log retention.", auditRetentionAdminResponseSchema), ...errors } }), adminRoute(), async c => {
    const id = c.req.param("organizationId")
    if (!isDenTypeId("organization", id)) return c.json({ error: "invalid_request", message: "Invalid organization id." }, 400)
    c.header("Cache-Control", "no-store")
    const result = await retentionState(normalizeDenTypeId("organization", id))
    return result ? c.json(result) : c.json({ error: "not_found", message: "Organization not found." }, 404)
  })

  app.put(auditRetentionCoveredRoute.path, describeRoute({ operationId: "updateAuditRetention", tags: ["Admin"], summary: "Set an organization's audit log retention", description: "Sets how many days audit history is kept, from 1 to 365. Send the revision last read (0 when there is no policy yet: the default policy is created first, for organizations with audit logs). A changed revision answers 409 audit_policy_changed. The change and its audit.retention.updated event commit together; the same value records nothing. Older history is deleted only where the auditRetentionCleanup feature is on. Platform administrators only.", responses: {
    200: jsonResponse("Retention saved.", auditRetentionAdminResponseSchema), ...errors,
    409: jsonResponse("The policy changed, the organization has no audit logs, or deployment capture is off.", conflictSchema),
  } }), adminRoute(), jsonValidator(auditRetentionUpdateSchema), async c => {
    const id = c.req.param("organizationId")
    if (!isDenTypeId("organization", id)) return c.json({ error: "invalid_request", message: "Invalid organization id." }, 400)
    const organizationId = normalizeDenTypeId("organization", id)
    const input = c.req.valid("json"), adminUserId = normalizeDenTypeId("user", c.get("user").id)
    c.header("Cache-Control", "no-store")
    try {
      const outcome = await db.transaction(async tx => {
        const [organization] = await tx.select({ id: OrganizationTable.id }).from(OrganizationTable).where(eq(OrganizationTable.id, organizationId)).limit(1)
        if (!organization) return "missing"
        const { entitlement } = await readAuditAvailability(tx, organizationId)
        const initialization = await initializeAuditPolicyInTx(tx, organizationId, env.auditCaptureEnabled)
        if (!initialization.policy) return entitlement.enabled ? "audit_capture_unavailable" : "audit_not_entitled"
        // Revision zero means absent: only the request that created the default policy may use it.
        if (input.expectedRevision === 0 && !initialization.initialized) throw new AuditLogError("audit_policy_changed")
        if (initialization.initialized && input.expectedRevision !== 0) throw new AuditLogError("audit_policy_changed")
        await setAuditRetentionDays(tx, { retentionDays: input.retentionDays, expectedRevision: initialization.initialized ? initialization.policy.revision : input.expectedRevision, context: {
          organizationId, actor: { type: "user", id: adminUserId }, principalKey: `user:${adminUserId}:platform_admin`,
          kind: "audit.policy", scope: organizationId, origin: "platform_admin", originTrust: "authenticated", requestId: currentAuditRequestId() ?? createDenTypeId("request"),
        } })
        return null
      })
      if (outcome === "missing") return c.json({ error: "not_found", message: "Organization not found." }, 404)
      if (outcome) return c.json({ error: outcome, message: conflictMessages[outcome] }, 409)
      const result = await retentionState(organizationId)
      return result ? c.json(result) : c.json({ error: "not_found", message: "Organization not found." }, 404)
    } catch (error) {
      if (error instanceof AuditLogError && error.code === "audit_policy_changed") return c.json({ error: error.code, message: conflictMessages.audit_policy_changed }, 409)
      throw error
    }
  })
}
