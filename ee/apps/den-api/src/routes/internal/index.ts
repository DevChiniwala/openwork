import { timingSafeEqual } from "node:crypto"
import { deleteExpiredAuditOperations, refreshAuditUsageCounts } from "@openwork-ee/den-db/audit-log"
import { AuditPolicyTable } from "@openwork-ee/den-db/schema"
import type { Env, Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { organizationFeatureEnabled } from "../../features.js"
import { tokenRoute } from "../../middleware/index.js"
import { appLogger } from "../../observability/logger.js"
import { jsonResponse } from "../../openapi.js"

// Scheduled maintenance endpoints, called by a cron (Helm CronJob
// `den-audit-usage`, Render cron job `den-audit-usage`; the retention run is
// wired into the Helm CronJob only) with
// `Authorization: Bearer $DEN_MAINTENANCE_TOKEN`. Same shape as the Gateway's
// POST /internal/rollups/run: 404 when the token is not configured, 401 on a
// wrong token. Tagged Internal, so the published API document excludes them.

const logger = appLogger.child({ component: "internal_maintenance" })
const errorSchema = z.object({ error: z.enum(["not_found", "unauthorized", "refresh_failed", "retention_failed"]) })
const usageRefreshSchema = z.object({ organizations: z.number().int().nonnegative(), refreshedAt: z.string().datetime() })
const retentionRunSchema = z.object({
  organizations: z.number().int().nonnegative(), cleaned: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
  deletedOperations: z.number().int().nonnegative(), deletedEvents: z.number().int().nonnegative(), complete: z.boolean(), ranAt: z.string().datetime(),
})
// Bounded so one run fits the cron job's deadline; leftovers are taken next run.
const RETENTION_BATCH_SIZE = 200
const RETENTION_MAX_BATCHES_PER_ORGANIZATION = 50
const RETENTION_TIME_BUDGET_MS = 240_000

function constantTimeEquals(a: string, b: string) {
  const left = new Uint8Array(Buffer.from(a))
  const right = new Uint8Array(Buffer.from(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

function isAuthorized(header: string | undefined, token: string) {
  const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null
  return bearer !== null && constantTimeEquals(bearer, token)
}

export function registerInternalRoutes<T extends Env>(app: Hono<T>) {
  app.post(
    "/internal/audit/retention/run",
    describeRoute({
      tags: ["Internal"],
      security: [{ maintenanceToken: [] }],
      summary: "Delete audit history older than each organization's retention window",
      description: "For every organization with an audit policy and the auditRetentionCleanup feature on, permanently deletes whole operations (events, references, usage) first recorded more than its retention days ago, in bounded batches. Running operations and operations still accepting related events are kept. Organizations without the feature, and keep_all policies, are untouched. Stops after a time budget; complete is false when work remains for the next run. Answers 404 when DEN_MAINTENANCE_TOKEN is not configured.",
      responses: {
        200: jsonResponse("Cleanup ran.", retentionRunSchema),
        401: jsonResponse("Missing or wrong maintenance token.", errorSchema),
        404: jsonResponse("Maintenance endpoints are not configured on this deployment.", errorSchema),
        500: jsonResponse("The run could not list organizations; nothing was deleted.", errorSchema),
      },
    }),
    tokenRoute,
    async (c) => {
      const token = env.maintenanceToken
      if (!token) return c.json({ error: "not_found" }, 404)
      if (!isAuthorized(c.req.header("authorization"), token)) return c.json({ error: "unauthorized" }, 401)
      const startedAt = Date.now()
      const deadline = startedAt + RETENTION_TIME_BUDGET_MS
      let policies: Array<{ organizationId: string; retentionDays: number }>
      try {
        policies = await db.select({ organizationId: AuditPolicyTable.organization_id, retentionDays: AuditPolicyTable.retention_days }).from(AuditPolicyTable)
      } catch (error) {
        logger.error("audit retention run failed", { duration_ms: Date.now() - startedAt, error_name: error instanceof Error ? error.name : typeof error })
        return c.json({ error: "retention_failed" }, 500)
      }
      const summary = { organizations: policies.length, cleaned: 0, failed: 0, deletedOperations: 0, deletedEvents: 0, complete: true }
      for (const policy of policies) {
        if (Date.now() >= deadline) {
          summary.complete = false
          break
        }
        try {
          // Organization-owned background policy: organization state only, no member.
          if (!await organizationFeatureEnabled(policy.organizationId, "auditRetentionCleanup")) continue
          const result = await deleteExpiredAuditOperations(db, { organizationId: policy.organizationId, now: new Date(), retentionDays: policy.retentionDays, batchSize: RETENTION_BATCH_SIZE, maxBatches: RETENTION_MAX_BATCHES_PER_ORGANIZATION, deadline })
          summary.cleaned++
          summary.deletedOperations += result.operations
          summary.deletedEvents += result.events
          if (!result.complete) summary.complete = false
          if (result.operations) logger.info("audit retention cleaned organization", { organization_id: policy.organizationId, retention_days: policy.retentionDays, operations: result.operations, events: result.events, batches: result.batches, complete: result.complete })
        } catch (error) {
          summary.failed++
          summary.complete = false
          logger.error("audit retention failed for organization", { organization_id: policy.organizationId, error_name: error instanceof Error ? error.name : typeof error })
        }
      }
      logger.info("audit retention run finished", { ...summary, duration_ms: Date.now() - startedAt })
      return c.json({ ...summary, ranAt: new Date().toISOString() })
    },
  )

  app.post(
    "/internal/audit/usage/refresh",
    describeRoute({
      tags: ["Internal"],
      security: [{ maintenanceToken: [] }],
      summary: "Recompute audit usage totals",
      description: "Recomputes every organization's audit usage totals (retained operations, events, logical bytes) from the stored rows and saves them with the time they were measured. The audit write path never updates these totals, so a scheduled caller runs this (daily by default). Answers 404 when DEN_MAINTENANCE_TOKEN is not configured.",
      responses: {
        200: jsonResponse("Totals recomputed.", usageRefreshSchema),
        401: jsonResponse("Missing or wrong maintenance token.", errorSchema),
        404: jsonResponse("Maintenance endpoints are not configured on this deployment.", errorSchema),
        500: jsonResponse("The refresh failed; totals keep their previous values.", errorSchema),
      },
    }),
    tokenRoute,
    async (c) => {
      const token = env.maintenanceToken
      if (!token) return c.json({ error: "not_found" }, 404)
      if (!isAuthorized(c.req.header("authorization"), token)) return c.json({ error: "unauthorized" }, 401)
      const startedAt = Date.now()
      try {
        const summary = await refreshAuditUsageCounts(db)
        logger.info("audit usage totals refreshed", { organizations: summary.organizations, duration_ms: Date.now() - startedAt })
        return c.json(summary)
      } catch (error) {
        logger.error("audit usage refresh failed", { duration_ms: Date.now() - startedAt, error_name: error instanceof Error ? error.name : typeof error })
        return c.json({ error: "refresh_failed" }, 500)
      }
    },
  )
}
