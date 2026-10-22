"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Lock } from "lucide-react";
import { DenButton } from "../../app/(den)/_components/ui/button";
import { DenInput } from "../../app/(den)/_components/ui/input";
import { requestAdmin, sendAdmin } from "./admin-request";
import type { AdminFeatureAccessFailure } from "./admin-organization-feature-controls";

type EnterpriseSubscription = {
  status: string;
  quantity: number;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

type EnterpriseBilling = {
  featureEnabled: boolean;
  configured: boolean;
  users: number;
  minimumUsers: number;
  billableUsers: number;
  subscription: EnterpriseSubscription | null;
};

const ONGOING_STATUSES = new Set(["active", "trialing", "incomplete", "past_due", "unpaid", "paused"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSubscription(value: unknown): EnterpriseSubscription | null {
  if (!isRecord(value)) return null;
  return {
    status: typeof value.status === "string" ? value.status : "unknown",
    quantity: typeof value.quantity === "number" ? value.quantity : 0,
    stripeSubscriptionId: typeof value.stripeSubscriptionId === "string" ? value.stripeSubscriptionId : null,
    stripePriceId: typeof value.stripePriceId === "string" ? value.stripePriceId : null,
    currentPeriodEnd: typeof value.currentPeriodEnd === "string" ? value.currentPeriodEnd : null,
    cancelAtPeriodEnd: value.cancelAtPeriodEnd === true,
  };
}

export function parseEnterpriseBilling(payload: unknown): EnterpriseBilling | null {
  const value = isRecord(payload) && isRecord(payload.enterprise) ? payload.enterprise : null;
  if (!value || typeof value.users !== "number" || typeof value.minimumUsers !== "number" || typeof value.billableUsers !== "number") return null;
  return {
    featureEnabled: value.featureEnabled === true,
    configured: value.configured === true,
    users: value.users,
    minimumUsers: value.minimumUsers,
    billableUsers: value.billableUsers,
    subscription: parseSubscription(value.subscription),
  };
}

const formatDate = (value: string | null) => value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" }) : "Not available";

/**
 * Platform admin controls for the sales-led Enterprise plan: start a Stripe
 * Enterprise subscription on a customer's contract price and change its
 * committed minimum users. Behind the enterprisePlan feature.
 */
export function AdminEnterpriseBilling({ organizationId, onAccessFailure }: { organizationId: string; onAccessFailure: (failure: AdminFeatureAccessFailure) => void }) {
  const path = `/v1/admin/organizations/${encodeURIComponent(organizationId)}/enterprise-subscription`;
  const [data, setData] = useState<EnterpriseBilling | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [priceId, setPriceId] = useState("");
  const [minimumUsers, setMinimumUsers] = useState("0");
  const [billingEmail, setBillingEmail] = useState("");
  const [daysUntilDue, setDaysUntilDue] = useState("30");
  const [minimumDraft, setMinimumDraft] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await requestAdmin(path, parseEnterpriseBilling, signal);
    if (result.access === "ready") {
      setData(result.data);
      setMinimumDraft(String(result.data.minimumUsers));
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

  async function startEnterprise(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const result = await sendAdmin(path, "POST", {
      priceId: priceId.trim(),
      minimumUsers: Number(minimumUsers),
      billingEmail: billingEmail.trim(),
      daysUntilDue: Number(daysUntilDue),
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const next = parseEnterpriseBilling(result.payload);
    if (next) {
      setData(next);
      setMinimumDraft(String(next.minimumUsers));
    }
  }

  async function saveMinimum(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const result = await sendAdmin(path, "PATCH", { minimumUsers: Number(minimumDraft) });
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const next = parseEnterpriseBilling(result.payload);
    if (next) setData(next);
  }

  const heading = <h3 id="admin-enterprise-billing-title" className="text-sm font-medium">Enterprise plan billing</h3>;

  if (!data) {
    return <section className="border-t border-[var(--dls-border)] py-5" aria-labelledby="admin-enterprise-billing-title" aria-busy={!loadError}>
      {heading}
      <p className="mt-2 text-xs text-[color:var(--dls-text-secondary)]">{loadError ?? "Loading…"}</p>
    </section>;
  }

  const subscription = data.subscription;
  const ongoing = subscription !== null && ONGOING_STATUSES.has(subscription.status);

  return <section className="border-t border-[var(--dls-border)] py-5 text-[color:var(--dls-text-primary)]" aria-labelledby="admin-enterprise-billing-title" data-testid="admin-enterprise-billing">
    <div className="flex flex-wrap items-center justify-between gap-2">
      {heading}
      <span className="text-xs text-[color:var(--dls-text-secondary)]">{ongoing ? `Stripe: ${subscription.status.replace(/_/g, " ")}` : "No Enterprise subscription"}</span>
    </div>

    {ongoing ? <div className="mt-3 grid gap-3 text-sm">
      <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        <div><dt className="text-[color:var(--dls-text-secondary)]">Users</dt><dd className="mt-1 text-sm tabular-nums">{data.users}</dd></div>
        <div><dt className="text-[color:var(--dls-text-secondary)]">Committed minimum</dt><dd className="mt-1 text-sm tabular-nums">{data.minimumUsers}</dd></div>
        <div><dt className="text-[color:var(--dls-text-secondary)]">Billed in Stripe</dt><dd className="mt-1 text-sm tabular-nums">{subscription.quantity}{subscription.quantity !== data.billableUsers ? ` (updating to ${data.billableUsers})` : ""}</dd></div>
        <div><dt className="text-[color:var(--dls-text-secondary)]">{subscription.cancelAtPeriodEnd ? "Ends" : "Next invoice"}</dt><dd className="mt-1 text-sm">{formatDate(subscription.currentPeriodEnd)}</dd></div>
      </dl>
      <p className="break-all text-xs text-[color:var(--dls-text-secondary)]">Subscription {subscription.stripeSubscriptionId ?? "unknown"} · price {subscription.stripePriceId ?? "unknown"}. Change the price, end the plan or credit invoices in Stripe; OpenWork follows.</p>
      {data.featureEnabled ? <form className="flex flex-wrap items-end gap-2" onSubmit={saveMinimum}>
        <label className="grid gap-1 text-xs">Committed minimum users<DenInput aria-label="Committed minimum users" type="number" min="0" max="100000" step="1" required value={minimumDraft} disabled={saving} onChange={(event) => setMinimumDraft(event.target.value)} /></label>
        <DenButton type="submit" size="sm" variant="secondary" loading={saving} disabled={minimumDraft === String(data.minimumUsers)}>Save minimum</DenButton>
      </form> : null}
    </div> : !data.featureEnabled ? <p className="mt-2 text-xs text-[color:var(--dls-text-secondary)]"><Lock className="mr-1 inline" size={12} aria-hidden="true" />Turn on “Enterprise plan billing” for this organization on its Features page to start an Enterprise subscription.</p>
      : !data.configured ? <p className="mt-2 text-xs text-[color:var(--dls-text-secondary)]"><Lock className="mr-1 inline" size={12} aria-hidden="true" />Stripe Enterprise billing is not set up on this deployment (STRIPE_ENTERPRISE_PRODUCT_ID).</p>
      : <form className="mt-3 grid max-w-xl gap-3" onSubmit={startEnterprise} data-testid="admin-enterprise-start-form">
        <p className="text-xs text-[color:var(--dls-text-secondary)]">Creates a Stripe subscription billed by invoice: every user at the contract price, never fewer than the committed minimum. A Team plan subscription is canceled with a prorated credit, and the organization becomes Enterprise.</p>
        <label className="grid gap-1 text-xs">Contract price (Stripe price id on the Enterprise product)<DenInput aria-label="Enterprise price id" required placeholder="price_…" value={priceId} disabled={saving} onChange={(event) => setPriceId(event.target.value)} /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-xs">Committed minimum users<DenInput aria-label="Committed minimum users" type="number" min="0" max="100000" step="1" required value={minimumUsers} disabled={saving} onChange={(event) => setMinimumUsers(event.target.value)} /></label>
          <label className="grid gap-1 text-xs">Invoice due after (days)<DenInput aria-label="Invoice due after days" type="number" min="1" max="90" step="1" required value={daysUntilDue} disabled={saving} onChange={(event) => setDaysUntilDue(event.target.value)} /></label>
        </div>
        <label className="grid gap-1 text-xs">Billing email<DenInput aria-label="Billing email" type="email" required value={billingEmail} disabled={saving} onChange={(event) => setBillingEmail(event.target.value)} /></label>
        <p className="text-xs" aria-live="polite">First invoice: {Math.max(1, data.users, Number(minimumUsers) || 0)} users ({data.users} now{Number(minimumUsers) > data.users ? `, minimum ${Number(minimumUsers)}` : ""}).</p>
        <div><DenButton type="submit" size="sm" loading={saving} data-testid="admin-enterprise-start-submit">Start Enterprise plan</DenButton></div>
      </form>}

    {error ? <p role="alert" className="mt-3 text-xs text-red-700">{error}</p> : null}
  </section>;
}
