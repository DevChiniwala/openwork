"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Lock } from "lucide-react";
import { auditRetentionAdminResponseSchema, type AuditRetentionAdminResponse } from "@openwork/types/den/audit";
import { DenButton } from "../../app/(den)/_components/ui/button";
import { DenInput } from "../../app/(den)/_components/ui/input";
import { requestAdmin, sendAdmin } from "./admin-request";
import type { AdminFeatureAccessFailure } from "./admin-organization-feature-controls";

export function parseAuditRetention(payload: unknown): AuditRetentionAdminResponse | null {
  const parsed = auditRetentionAdminResponseSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

const days = (value: number) => `${value} ${value === 1 ? "day" : "days"}`;

/**
 * Platform admin control for how long an organization's audit history is
 * kept (90 days by default, up to 365). Deletion of older history happens
 * only where the auditRetentionCleanup feature is on.
 */
export function AdminAuditRetention({ organizationId, onAccessFailure }: { organizationId: string; onAccessFailure: (failure: AdminFeatureAccessFailure) => void }) {
  const path = `/v1/admin/organizations/${encodeURIComponent(organizationId)}/audit-retention`;
  const [data, setData] = useState<AuditRetentionAdminResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await requestAdmin(path, parseAuditRetention, signal);
    if (result.access === "ready") {
      setData(result.data);
      setDraft(String(result.data.retentionDays));
      setLoadError(null);
    } else if (result.access === "signed-out" || result.access === "forbidden") {
      onAccessFailure({ access: result.access, message: result.message });
    } else {
      setLoadError(result.message);
    }
  }, [path, onAccessFailure]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!data) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const result = await sendAdmin(path, "PUT", { retentionDays: Number(draft), expectedRevision: data.revision ?? 0 });
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      // A changed policy needs the latest revision before another save.
      if (result.code === "audit_policy_changed") void load().catch(() => undefined);
      return;
    }
    const next = parseAuditRetention(result.payload);
    if (next) {
      setData(next);
      setDraft(String(next.retentionDays));
      setSaved(true);
    }
  }

  const heading = <h3 id="admin-audit-retention-title" className="text-sm font-medium">Audit log retention</h3>;

  if (!data) {
    return <section className="border-t border-[var(--dls-border)] py-5" aria-labelledby="admin-audit-retention-title" aria-busy={!loadError}>
      {heading}
      {loadError ? <p role="alert" className="mt-2 text-xs text-red-700">{loadError}</p> : <div className="mt-3 h-8 w-64 rounded-[var(--radius)] bg-[var(--dls-hover)]" aria-hidden="true" />}
    </section>;
  }

  const value = Number(draft);
  const valid = Number.isInteger(value) && value >= 1 && value <= data.maximumRetentionDays;

  return <section className="border-t border-[var(--dls-border)] py-5 text-[color:var(--dls-text-primary)]" aria-labelledby="admin-audit-retention-title" data-testid="admin-audit-retention">
    <div className="flex flex-wrap items-center justify-between gap-2">
      {heading}
      <span className="text-xs text-[color:var(--dls-text-secondary)]" data-testid="admin-audit-retention-cleanup">{data.cleanupEnabled ? `Cleanup on: history older than ${days(data.retentionDays)} is deleted` : "Cleanup off: nothing is deleted"}</span>
    </div>
    <dl className="mt-3 grid grid-cols-3 gap-3 text-xs sm:max-w-md">
      <div><dt className="text-[color:var(--dls-text-secondary)]">Kept for</dt><dd className="mt-1 text-sm tabular-nums">{days(data.retentionDays)}</dd></div>
      <div><dt className="text-[color:var(--dls-text-secondary)]">Default</dt><dd className="mt-1 text-sm tabular-nums">{days(data.defaultRetentionDays)}</dd></div>
      <div><dt className="text-[color:var(--dls-text-secondary)]">Maximum</dt><dd className="mt-1 text-sm tabular-nums">{days(data.maximumRetentionDays)}</dd></div>
    </dl>
    {data.available ? <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={save}>
      <label className="grid gap-1 text-xs">Days to keep history<DenInput aria-label="Days to keep audit history" type="number" min="1" max={String(data.maximumRetentionDays)} step="1" required value={draft} disabled={saving}
        onChange={(event) => { setDraft(event.target.value); setSaved(false); }} /></label>
      <DenButton type="submit" size="sm" variant="secondary" loading={saving} disabled={!valid || value === data.retentionDays}>Save retention</DenButton>
      {saved ? <span className="text-xs text-[color:var(--dls-text-secondary)]" aria-live="polite">Saved</span> : null}
    </form> : <p className="mt-2 text-xs text-[color:var(--dls-text-secondary)]"><Lock className="mr-1 inline" size={12} aria-hidden="true" />Audit logs need an Enterprise plan first.</p>}
    {error ? <p role="alert" className="mt-3 text-xs text-red-700">{error}</p> : null}
  </section>;
}
