/**
 * Audit retention is time-based: 90 days by default, 1 to 365 days per
 * organization. The retention preview counts operations older than the stored
 * window as age candidates, and the change route and its lifecycle event are
 * declared in the audit coverage registries.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { previewAuditRetention } from "@openwork-ee/den-db/audit-accounting"
import { DEFAULT_AUDIT_RETENTION_DAYS, MAX_AUDIT_RETENTION_DAYS, auditPolicySchema, auditRetentionDaysSchema, auditRetentionUpdateSchema, auditUsageResponseSchema } from "@openwork/types/den/audit"
import { auditRetentionMaxAgeMs } from "../src/audit/pilot-policy.js"

const organizationId = "org_01kc0000000000000000000000"
const policy = {
  organizationId, revision: 1, source: "cloud", enabled: true, categories: ["lifecycle"], allowance: 6_000_000, excessMode: "delete_oldest",
  effectiveAt: "2026-10-01T00:00:00.000Z", captureStartedAt: null, attachmentWindowSeconds: 300, retentionDays: DEFAULT_AUDIT_RETENTION_DAYS,
}

test("retention days default to 90 and accept whole days from 1 to 365", () => {
  assert.equal(DEFAULT_AUDIT_RETENTION_DAYS, 90)
  assert.equal(MAX_AUDIT_RETENTION_DAYS, 365)
  for (const days of [1, 90, 365]) assert.equal(auditRetentionDaysSchema.safeParse(days).success, true, `${days}`)
  for (const days of [0, -1, 366, 1.5, Number.NaN]) assert.equal(auditRetentionDaysSchema.safeParse(days).success, false, `${days}`)
})

test("a policy carries its retention days, and the update accepts only days and the expected revision", () => {
  assert.equal(auditPolicySchema.safeParse(policy).success, true)
  const { retentionDays: _retentionDays, ...withoutDays } = policy
  assert.equal(auditPolicySchema.safeParse(withoutDays).success, false)
  assert.equal(auditPolicySchema.safeParse({ ...policy, retentionDays: 366 }).success, false)
  assert.equal(auditRetentionUpdateSchema.safeParse({ retentionDays: 30, expectedRevision: 0 }).success, true)
  assert.equal(auditRetentionUpdateSchema.safeParse({ retentionDays: 30, expectedRevision: 1, allowance: 10 }).success, false)
  assert.equal(auditRetentionUpdateSchema.safeParse({ retentionDays: 400, expectedRevision: 1 }).success, false)
})

test("usage reports cleanup as dry_run or age_based, nothing else", () => {
  const usage = {
    entitlement: { enabled: true, source: "enterprise_plan" }, captureOn: true, captureAvailable: true, policy, captureEnabled: true,
    retainedOperations: 0, eventCount: 0, logicalBytes: 0, oldestAvailableAt: null, measuredAt: null, billing: "disabled", drains: "not_configured",
  }
  for (const cleanup of ["dry_run", "age_based"]) assert.equal(auditUsageResponseSchema.safeParse({ ...usage, cleanup }).success, true, cleanup)
  assert.equal(auditUsageResponseSchema.safeParse({ ...usage, cleanup: "enabled" }).success, false)
})

test("the retention preview treats operations older than the stored window as age candidates", () => {
  const now = "2026-10-22T00:00:00.000Z"
  const day = 86_400_000
  const operation = (id: string, ageDays: number, outcome: "succeeded" | "running" = "succeeded") => ({
    id, organizationId, firstRecordedAt: new Date(Date.parse(now) - ageDays * day).toISOString(), outcome, trustedJobPending: false, deliveryProtectedUntil: null, attachmentExpiresAt: null,
  })
  const operations = [operation("old", 31), operation("edge", 30), operation("running", 45, "running"), operation("recent", 29)]
  const preview = previewAuditRetention({
    organizationId, now, policy: { revision: 1, allowance: 6_000_000, excessMode: "delete_oldest", maxAgeMs: auditRetentionMaxAgeMs(30) },
    installationMaximumOperations: null, retainedOperations: operations.length, operations, maxCandidates: 100,
  })
  assert.equal(auditRetentionMaxAgeMs(DEFAULT_AUDIT_RETENTION_DAYS), 90 * day)
  assert.deepEqual(preview.candidates.map((candidate) => [candidate.id, candidate.reason]), [["old", "age"], ["edge", "age"]])
  assert.equal(preview.protectedAgeExpiredCount, 1, "a running operation is never a candidate")
  const keepAll = previewAuditRetention({
    organizationId, now, policy: { revision: 1, allowance: 6_000_000, excessMode: "keep_all", maxAgeMs: auditRetentionMaxAgeMs(30) },
    installationMaximumOperations: null, retainedOperations: operations.length, operations, maxCandidates: 100,
  })
  assert.equal(keepAll.candidateCount, 0, "keep_all keeps everything")
})

test("the retention change route and its lifecycle event are declared", async () => {
  const [{ findAuditRouteDeclaration }, { supportedAuditEventTypes }] = await Promise.all([import("../src/audit/routes/index.js"), import("../src/audit/coverage.js")])
  const change = findAuditRouteDeclaration("PUT", "/v1/admin/organizations/:organizationId/audit-retention")
  assert.equal(change?.class, "domain_audit", "generic request capture must not bind the policy this route changes")
  assert.equal(change?.attribution, "path:organizationId")
  assert.equal(findAuditRouteDeclaration("GET", "/v1/admin/organizations/:organizationId/audit-retention")?.class, "tenant_read")
  assert.equal(findAuditRouteDeclaration("POST", "/internal/audit/retention/run")?.class, "platform")
  assert.ok(supportedAuditEventTypes().includes("audit.retention.updated"))
})
