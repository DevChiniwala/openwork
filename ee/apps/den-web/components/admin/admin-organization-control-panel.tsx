"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronRight, Lock, Plus, X } from "lucide-react";
import { organizationControlPanelSchema, organizationAccessSettingSchema, organizationBenefitSchema, type OrganizationBenefit, type OrganizationControlPanel, type OrganizationGrant, type OrganizationGrantInput } from "@openwork/types/den/organization-grants";
import { DenButton } from "../../app/(den)/_components/ui/button";
import { DenInput } from "../../app/(den)/_components/ui/input";
import { DenSelect } from "../../app/(den)/_components/ui/select";
import { DenTextarea } from "../../app/(den)/_components/ui/textarea";
import { requestAdmin, sendAdmin } from "./admin-request";
import type { AdminFeatureAccessFailure } from "./admin-organization-feature-controls";

const labels = { freeAuto: "Free Auto", openworkWeb: "Complimentary OpenWork Web" };
const money = (value: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
const date = (value: string | null) => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "No expiration";
const localDate = (value: Date) => new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const parsePanel = (value: unknown) => { const result = organizationControlPanelSchema.safeParse(value); return result.success ? result.data : null; };

type Draft = { feature: OrganizationBenefit; kind: OrganizationGrantInput["kind"]; amount: string; scheduled: boolean; startsAt: string; expires: boolean; expiresAt: string; reason: string; requestId: string };
function freshDraft(): Draft {
  const now = new Date();
  return { feature: "freeAuto", kind: "usage", amount: "25", scheduled: false, startsAt: localDate(now), expires: true, expiresAt: localDate(new Date(now.getTime() + 30 * 86_400_000)), reason: "", requestId: crypto.randomUUID() };
}

export function AdminOrganizationControlPanel({ organizationId, onAccessFailure }: { organizationId: string; onAccessFailure: (failure: AdminFeatureAccessFailure) => void }) {
  const path = `/v1/admin/organizations/${encodeURIComponent(organizationId)}/control-panel`;
  const [data, setData] = useState<OrganizationControlPanel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [history, setHistory] = useState(false);
  const [offset, setOffset] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState("");
  const [legacyReason, setLegacyReason] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    try {
      const result = await requestAdmin(`${path}?history=${history ? "1" : "0"}&offset=${offset}`, parsePanel, signal);
      if (signal?.aborted) return;
      if (result.access === "ready") { setData(result.data); setError(null); }
      else if (result.access === "signed-out" || result.access === "forbidden") { setData(null); onAccessFailure({ access: result.access, message: result.message }); }
      else setError(result.message);
    } catch (failure: unknown) {
      if (!signal?.aborted) setError(failure instanceof Error ? failure.message : "Could not refresh this organization’s access. Retry to verify it.");
    } finally { if (!signal?.aborted) setRefreshing(false); }
  }, [path, history, offset, onAccessFailure]);

  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  async function mutate(suffix: string, method: "PUT" | "POST", body: unknown, success: string) {
    if (savingRef.current || refreshing) return;
    savingRef.current = true; setSaving(true); setError(null);
    try {
      const result = await sendAdmin(suffix.startsWith("/v1/") ? suffix : `${path}${suffix}`, method, body);
      if (!result.ok) {
        if (result.status === 401 || result.status === 403) { setData(null); onAccessFailure({ access: result.status === 401 ? "signed-out" : "forbidden", message: result.message }); return; }
        throw new Error(result.message);
      }
      setNotice(success);
      if (suffix === "/grants") setDraft(null);
      if (suffix === "/grants" && (history || offset > 0)) { setHistory(false); setOffset(0); }
      else await load();
    } catch (failure: unknown) { setError(failure instanceof Error ? failure.message : "Could not confirm the save. Retry to verify the current state."); }
    finally { savingRef.current = false; setSaving(false); }
  }

  function changeDraft(change: Partial<Draft>) {
    setDraft(current => current ? { ...current, ...change, requestId: crypto.randomUUID() } : null);
  }

  async function createGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const startsAt = draft.scheduled ? new Date(draft.startsAt) : null;
    const expiresAt = draft.expires ? new Date(draft.expiresAt) : null;
    if ((startsAt && !Number.isFinite(startsAt.getTime())) || (expiresAt && !Number.isFinite(expiresAt.getTime()))) { setError("Choose valid start and expiration dates."); return; }
    const body: OrganizationGrantInput = { requestId: draft.requestId, feature: draft.feature, kind: draft.kind, amountUsd: draft.kind === "usage" ? Number(draft.amount) : null,
      startsAt: startsAt?.toISOString() ?? null, expiresAt: expiresAt?.toISOString() ?? null, reason: draft.reason.trim() };
    await mutate("/grants", "POST", body, "Grant created.");
  }

  if (!data) return <section className="py-5" aria-busy={refreshing} aria-label="Organization control panel">
    {error ? <div role="alert"><p className="text-sm text-[color:var(--ow-danger)]">{error}</p><DenButton variant="secondary" size="sm" onClick={() => void load()}>Retry control panel</DenButton></div>
      : <div className="grid gap-3" aria-label="Checking access"><div className="h-10 rounded-md bg-[var(--dls-hover)]" /><div className="h-24 rounded-md bg-[var(--dls-hover)]" /><div className="h-32 rounded-md bg-[var(--dls-hover)]" /></div>}
  </section>;

  if (!data.enabled) return <section className="py-5">
    <h2 className="flex items-center gap-2 text-sm font-medium text-[color:var(--dls-text-primary)]"><Lock size={16} aria-hidden="true" />Organization grants are off</h2>
    <Link href={`/admin/organizations/${encodeURIComponent(organizationId)}/features`} prefetch={false} className="mt-3 inline-block text-sm text-[color:var(--dls-text-secondary)] underline underline-offset-2">Enable Organization control panel and grants in Features</Link>
    <form className="mt-6 grid max-w-md gap-3 border-t border-[var(--dls-border)] pt-4" onSubmit={event => { event.preventDefault(); void mutate(`/v1/admin/organizations/${encodeURIComponent(organizationId)}/openwork-web-access`, "PUT", { enabled: !data.legacyWebAccess, reason: legacyReason }, "Complimentary access setting saved."); }}>
      <h3 className="text-sm font-medium">Complimentary OpenWork Web</h3>
      <p className="text-xs text-[color:var(--dls-text-secondary)]">{data.legacyWebAccess ? "Existing complimentary access; no expiration" : "No complimentary access"}</p>
      <label className="grid gap-2 text-xs">Reason<DenInput aria-label="Complimentary access reason" value={legacyReason} required minLength={3} maxLength={500} disabled={saving} onChange={event => setLegacyReason(event.target.value)} /></label>
      <DenButton type="submit" size="sm" disabled={saving || refreshing} loading={saving}>{data.legacyWebAccess ? "Revoke complimentary access" : "Grant complimentary access"}</DenButton>
      {error ? <p role="alert" className="text-sm text-[color:var(--ow-danger)]">{error}</p> : null}
      <p role="status" className="text-xs text-[color:var(--dls-text-secondary)]">{notice}</p>
    </form>
  </section>;

  const busy = saving || refreshing;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const benefits: OrganizationBenefit[] = ["freeAuto", "openworkWeb"];
  return <section className="min-w-0 py-5 text-[color:var(--dls-text-primary)]" data-testid="admin-organization-control-panel" aria-busy={busy}>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-medium">Control panel</h2><DenButton size="sm" icon={Plus} disabled={busy || draft !== null} onClick={() => { setDraft(freshDraft()); setError(null); }}>Create grant</DenButton></div>
    {error ? <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 text-sm text-[color:var(--ow-danger)]"><p>{error}</p><DenButton size="sm" variant="secondary" disabled={busy} onClick={() => void load()}>Retry control panel</DenButton></div> : null}
    <div className={draft ? "grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]" : "min-w-0"}>
      <div className="min-w-0">
        <h3 className="mb-3 text-sm font-medium">Feature access</h3>
        <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem] gap-4 pb-2 text-xs text-[color:var(--dls-text-secondary)] lg:grid"><span>Feature</span><span>Effective access</span><span>Organization setting</span></div>
        {benefits.map(feature => <div key={feature} className="grid min-w-0 grid-cols-1 items-center gap-3 border-t border-[var(--dls-border)] py-3 sm:grid-cols-[minmax(0,1fr)_10rem] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem]">
          <span className="text-sm font-medium">{labels[feature]}</span>
          <div className="min-w-0 text-sm" data-testid={`admin-benefit-effective-${feature}`}><span className="inline-flex items-center gap-1.5">{data.access[feature].enabled ? null : <Lock size={12} aria-hidden="true" />}{data.access[feature].enabled ? "Enabled" : "Disabled"}</span><p className="mt-1 break-words text-xs text-[color:var(--dls-text-secondary)]">{data.access[feature].source}</p></div>
          <div className="min-w-0 sm:col-start-2 sm:row-start-auto lg:col-start-auto"><DenSelect aria-label={`${labels[feature]} organization setting`} value={data.access[feature].setting} disabled={busy} menuWidth="trigger" onChange={event => {
            const setting = organizationAccessSettingSchema.parse(event.target.value);
            void mutate("/access", "PUT", { feature, setting }, `${labels[feature]} setting saved.`);
          }}><option value="default">Use default</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></DenSelect></div>
        </div>)}

        <section className="mt-6 border-t border-[var(--dls-border)] pt-4" aria-labelledby="admin-free-auto-allowance">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 id="admin-free-auto-allowance" className="text-sm font-medium">Free Auto allowance</h3><span className="text-xs text-[color:var(--dls-text-secondary)]">{data.access.freeAuto.enabled ? "Subject to member policies" : "Blocked"}</span></div>
          <dl className="my-4 grid gap-5 sm:grid-cols-2"><div><dt className="text-xs text-[color:var(--dls-text-secondary)]">Standard allowance</dt><dd className="mt-1 text-lg font-medium tabular-nums">{money(data.freeAuto.weeklyLimitUsd)} <span className="text-xs font-normal text-[color:var(--dls-text-secondary)]">/ person / week</span></dd></div><div><dt className="text-xs text-[color:var(--dls-text-secondary)]">Extra usage grants</dt><dd data-testid="admin-grant-remaining" className="mt-1 text-lg font-medium tabular-nums">{data.freeAuto.unlimited ? "Unlimited" : money(data.freeAuto.extraRemainingUsd)} <span className="text-xs font-normal text-[color:var(--dls-text-secondary)]">{data.freeAuto.unlimited ? "" : "remaining"}</span></dd></div></dl>
          <p className="text-xs text-[color:var(--dls-text-secondary)]">{data.access.freeAuto.enabled ? data.freeAuto.unlimited ? "Finite grants are preserved while unlimited usage applies." : "Extra usage is shared by the organization after each member’s standard allowance. Standard allowance resets Monday, 00:00 UTC." : "Free Auto is blocked. Grant balances and original expiration dates remain in place."}</p>
        </section>

        <section className="mt-6 border-t border-[var(--dls-border)] pt-4" aria-labelledby="admin-grants-title">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 id="admin-grants-title" className="text-sm font-medium">Grants</h3><DenButton variant="ghost" size="inline" disabled={busy} onClick={() => { setHistory(value => !value); setOffset(0); }}>{history ? "Hide history" : "Show history"}</DenButton></div>
          {data.grants.length ? data.grants.map(grant => <GrantRow key={grant.id} grant={grant} busy={busy} onRevoke={() => void mutate(`/grants/${encodeURIComponent(grant.id)}/revoke`, "POST", undefined, "Grant revoked. History and usage retained.")} />) : <p className="py-4 text-sm text-[color:var(--dls-text-secondary)]">{history ? "No grants recorded." : "No active grants. Create a grant to add usage or feature access."}</p>}
          {data.hasMore || offset > 0 ? <div className="mt-3 flex justify-end gap-2"><DenButton variant="secondary" size="sm" disabled={busy || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 50))}>Previous grants</DenButton><DenButton variant="secondary" size="sm" disabled={busy || !data.hasMore} onClick={() => setOffset(value => value + 50)}>Next grants</DenButton></div> : null}
        </section>
        <p role="status" data-testid="admin-control-panel-status" aria-live="polite" className="mt-4 text-xs text-[color:var(--dls-text-secondary)]">{notice}</p>
      </div>

      {draft ? <section className="min-w-0 border-t border-[var(--dls-border)] pt-4 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0" aria-labelledby="admin-create-grant-title">
        <div className="mb-4 flex items-center justify-between gap-2"><h3 id="admin-create-grant-title" className="text-sm font-medium">Create grant</h3><DenButton variant="ghost" size="sm" aria-label="Close grant editor" disabled={saving} onClick={() => setDraft(null)}><X size={16} aria-hidden="true" /></DenButton></div>
        <form onSubmit={createGrant} className="grid gap-4" data-testid="admin-grant-form">
          <label className="grid min-w-0 gap-2 text-xs">Feature<DenSelect aria-label="Grant feature" value={draft.feature} disabled={saving} onChange={event => { const feature = organizationBenefitSchema.parse(event.target.value); changeDraft({ feature, kind: feature === "openworkWeb" ? "access" : "usage" }); }}><option value="freeAuto">Free Auto</option><option value="openworkWeb">Complimentary OpenWork Web</option></DenSelect></label>
          <label className="grid gap-2 text-xs">Grant type<DenSelect aria-label="Grant type" value={draft.kind} disabled={saving} onChange={event => { if (event.target.value === "access" || event.target.value === "usage" || event.target.value === "unlimited") changeDraft({ kind: event.target.value }); }}><option value="access">Feature access</option><option value="usage" disabled={draft.feature === "openworkWeb"}>Extra usage</option><option value="unlimited" disabled={draft.feature === "openworkWeb"}>Unlimited usage</option></DenSelect></label>
          {draft.kind === "usage" ? <label className="grid gap-2 text-xs">Usage credit (USD)<DenInput aria-label="Usage credit in USD" type="number" min="0.01" max="1000000" step="0.01" required value={draft.amount} disabled={saving} onChange={event => changeDraft({ amount: event.target.value })} /><span className="text-[color:var(--dls-text-secondary)]">One-time pool shared by the organization.</span></label> : null}
          <label className="grid gap-2 text-xs">Starts<DenSelect aria-label="Grant starts" value={draft.scheduled ? "date" : "now"} disabled={saving} onChange={event => changeDraft({ scheduled: event.target.value === "date" })}><option value="now">Immediately</option><option value="date">On a date</option></DenSelect></label>
          {draft.scheduled ? <label className="grid gap-2 text-xs">Start date<DenInput aria-label="Grant start date" type="datetime-local" required value={draft.startsAt} disabled={saving} onChange={event => changeDraft({ startsAt: event.target.value })} /></label> : null}
          <label className="grid gap-2 text-xs">Expires<DenSelect aria-label="Grant expiration" value={draft.expires ? "date" : "never"} disabled={saving} onChange={event => changeDraft({ expires: event.target.value === "date" })}><option value="date">On a date</option><option value="never">No expiration</option></DenSelect></label>
          {draft.expires ? <label className="grid gap-2 text-xs">Expiration date<DenInput aria-label="Grant expiration date" type="datetime-local" required value={draft.expiresAt} disabled={saving} onChange={event => changeDraft({ expiresAt: event.target.value })} /></label> : null}
          <label className="grid gap-2 text-xs">Reason<DenTextarea aria-label="Grant reason" rows={2} required minLength={3} maxLength={500} value={draft.reason} disabled={saving} placeholder="e.g. Extended evaluation" onChange={event => changeDraft({ reason: event.target.value })} /></label>
          <div className="grid gap-2 rounded-md bg-[var(--dls-hover)] p-3 text-xs" aria-live="polite"><span className="font-medium">{draft.kind === "usage" ? `${money(Number(draft.amount) || 0)} of extra ${labels[draft.feature]} usage` : draft.kind === "unlimited" ? "Unlimited Free Auto usage" : `${labels[draft.feature]} access`}</span><span>{draft.expires ? "Returns to the normal entitlement at expiration. Unused credit expires." : draft.kind === "usage" ? "Available until spent or revoked. No automatic refill." : "Available until revoked."}</span><span className="text-[color:var(--dls-text-secondary)]">Dates use {timezone}.</span></div>
          {data.access[draft.feature].setting === "disabled" ? <p className="text-xs text-[color:var(--dls-text-secondary)]"><Lock className="mr-1 inline" size={12} aria-hidden="true" />This feature is disabled. The grant will remain blocked until access is enabled; its expiration still runs.</p> : null}
          {draft.kind === "unlimited" ? <p className="text-xs text-[color:var(--dls-text-secondary)]">No usage allowance cap. Rate limits, capacity limits and organization policies still apply.</p> : null}
          <div className="flex flex-wrap justify-end gap-2"><DenButton type="button" variant="secondary" size="sm" disabled={saving} onClick={() => setDraft(null)}>Cancel</DenButton><DenButton data-testid="admin-grant-create-submit" type="submit" size="sm" disabled={busy} loading={saving}>Create grant</DenButton></div>
        </form>
      </section> : null}
    </div>
    <p className="mt-6 border-t border-[var(--dls-border)] pt-3 text-xs text-[color:var(--dls-text-secondary)]">Platform admin only. Dates use {timezone}. Confirmed {date(data.generatedAt)}.</p>
  </section>;
}

function GrantRow({ grant, busy, onRevoke }: { grant: OrganizationGrant; busy: boolean; onRevoke: () => void }) {
  const kind = grant.kind === "usage" ? "Extra usage" : grant.kind === "unlimited" ? "Unlimited usage" : "Feature access";
  return <details className="group min-w-0 border-t border-[var(--dls-border)] py-3" data-testid={`admin-grant-${grant.id}`}>
    <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-start gap-3 text-sm lg:grid-cols-[minmax(0,1fr)_6rem_9rem_5rem]">
      <span className="min-w-0 break-words"><span className="font-medium">{labels[grant.feature]} · {kind}</span><span className="mt-1 block text-xs text-[color:var(--dls-text-secondary)]">{grant.reason}</span></span>
      <span className="text-right text-xs tabular-nums">{grant.remainingUsd !== null ? money(grant.remainingUsd) : grant.kind === "unlimited" ? "Unlimited" : "Access"}{grant.amountUsd !== null ? <span className="mt-1 block text-[color:var(--dls-text-secondary)]">of {money(grant.amountUsd)}</span> : null}</span>
      <span className="text-xs text-[color:var(--dls-text-secondary)]">{date(grant.expiresAt)}</span><span className="flex items-center justify-end gap-1 text-right text-xs capitalize">{grant.state}<ChevronRight size={14} className="shrink-0 group-open:rotate-90" aria-hidden="true" /></span>
    </summary>
    <div className="mt-3 grid min-w-0 gap-2 text-xs text-[color:var(--dls-text-secondary)]"><span>Starts {date(grant.startsAt)}</span><span>Created {date(grant.createdAt)}</span><span className="break-all">Created by {grant.createdByUserId}</span>{grant.usedUsd > 0 ? <span>Recorded usage {money(grant.usedUsd)}</span> : null}{grant.revokedAt ? <span>Revoked {date(grant.revokedAt)}</span> : null}{["active", "scheduled", "blocked"].includes(grant.state) ? <DenButton variant="secondary" size="sm" className="justify-self-start" disabled={busy} onClick={onRevoke}>Revoke grant</DenButton> : null}</div>
  </details>;
}
