"use client";

import { Dialog } from "@base-ui/react/dialog";
import { useState, type FormEvent } from "react";
import { Lock } from "lucide-react";
import { DenButton, buttonVariants } from "../../app/(den)/_components/ui/button";
import { DenInput } from "../../app/(den)/_components/ui/input";
import { sendAdmin } from "./admin-request";
import { parseEnterpriseBilling, type EnterpriseBilling } from "./admin-enterprise-billing";

const DEFAULT_TRIAL_DAYS = 30;
/** The Free plan already includes 5 users; a trial never lowers that. */
const MIN_TRIAL_SEATS = 5;

const formatDate = (value: string) => new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });

/** yyyy-mm-dd in the admin's time zone, for a date input. */
function dateInputValue(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** The end of the chosen day in the admin's time zone. */
function endOfDay(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day, 23, 59, 59, 999);
  return Number.isFinite(date.getTime()) ? date : null;
}

type Draft = { seats: string; endsOn: string };

/**
 * Platform admin controls for an Enterprise trial: the organization is
 * Enterprise in the product until the end date, and its users are limited to
 * the trial's seats (its Free plan user limit). Starting or changing a trial
 * is behind the enterprisePlan feature; ending one never is.
 */
export function AdminEnterpriseTrial({ organizationId, data, onChange }: {
  organizationId: string;
  data: EnterpriseBilling;
  onChange: (next: EnterpriseBilling) => void;
}) {
  const path = `/v1/admin/organizations/${encodeURIComponent(organizationId)}/enterprise-trial`;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trial = data.plan.trial;
  const paidEnterprise = data.plan.tier === "enterprise" && data.plan.source === "stripe";
  const today = dateInputValue(new Date());

  function openDialog() {
    setError(null);
    setDraft(trial
      ? { seats: String(trial.seats), endsOn: dateInputValue(new Date(trial.endsAt)) }
      : { seats: String(Math.max(data.users, data.freeSeatCount)), endsOn: dateInputValue(new Date(Date.now() + DEFAULT_TRIAL_DAYS * 86_400_000)) });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const seats = Number(draft.seats);
    const endsAt = endOfDay(draft.endsOn);
    if (!Number.isInteger(seats) || seats < MIN_TRIAL_SEATS) return setError(`Seats must be a whole number of at least ${MIN_TRIAL_SEATS}, the users the Free plan already includes.`);
    if (!endsAt || endsAt.getTime() <= Date.now()) return setError("Choose an end date in the future.");
    setSaving(true);
    setError(null);
    const result = await sendAdmin(path, "PUT", { seats, endsAt: endsAt.toISOString() });
    setSaving(false);
    if (!result.ok) return setError(result.message);
    const next = parseEnterpriseBilling(result.payload);
    if (next) onChange(next);
    setDraft(null);
  }

  async function endTrial() {
    setSaving(true);
    setError(null);
    const result = await sendAdmin(path, "DELETE");
    setSaving(false);
    setConfirmEnd(false);
    if (!result.ok) return setError(result.message);
    const next = parseEnterpriseBilling(result.payload);
    if (next) onChange(next);
  }

  const seatsNumber = draft ? Number(draft.seats) : 0;

  return <section className="border-t border-[var(--dls-border)] py-5 text-[color:var(--dls-text-primary)]" aria-labelledby="admin-enterprise-trial-title" data-testid="admin-enterprise-trial">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 id="admin-enterprise-trial-title" className="text-sm font-medium">Enterprise trial</h3>
      {trial ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800" data-testid="admin-enterprise-trial-badge">Enterprise trial</span> : null}
    </div>

    {trial ? <div className="mt-3 grid gap-3">
      <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        <div><dt className="text-[color:var(--dls-text-secondary)]">Users</dt><dd className="mt-1 text-sm tabular-nums">{data.users} of {trial.seats}</dd></div>
        <div><dt className="text-[color:var(--dls-text-secondary)]">Seats</dt><dd className="mt-1 text-sm tabular-nums">{trial.seats}</dd></div>
        <div><dt className="text-[color:var(--dls-text-secondary)]">Started</dt><dd className="mt-1 text-sm">{formatDate(trial.startedAt)}</dd></div>
        <div><dt className="text-[color:var(--dls-text-secondary)]">Ends</dt><dd className="mt-1 text-sm">{formatDate(trial.endsAt)}</dd></div>
      </dl>
      <p className="text-xs text-[color:var(--dls-text-secondary)]">Enterprise in the product until it ends, with users (members and pending invitations) limited to {trial.seats}. Then the organization returns to Free, or to its paid plan, and its earlier Free plan user limit.</p>
      <div className="flex flex-wrap gap-2">
        <DenButton size="sm" variant="secondary" disabled={saving || !data.featureEnabled} onClick={openDialog}>Change trial</DenButton>
        {confirmEnd
          ? <>
            <DenButton size="sm" variant="destructive" loading={saving} onClick={() => void endTrial()} data-testid="admin-enterprise-trial-end-confirm">End trial now</DenButton>
            <DenButton size="sm" variant="ghost" disabled={saving} onClick={() => setConfirmEnd(false)}>Keep trial</DenButton>
          </>
          : <DenButton size="sm" variant="ghost" disabled={saving} onClick={() => setConfirmEnd(true)}>End trial</DenButton>}
      </div>
    </div> : <div className="mt-3 grid gap-3">
      {data.plan.lastTrial ? <p className="text-xs text-[color:var(--dls-text-secondary)]">Last trial: {data.plan.lastTrial.seats} seats, {data.plan.lastTrial.reason === "expired" ? "ended" : "ended by an admin"} {formatDate(data.plan.lastTrial.endedAt)}.</p> : null}
      {paidEnterprise
        ? <p className="text-xs text-[color:var(--dls-text-secondary)]">This organization already pays for Enterprise through Stripe.</p>
        : !data.featureEnabled
          ? <p className="text-xs text-[color:var(--dls-text-secondary)]"><Lock className="mr-1 inline" size={12} aria-hidden="true" />Turn on “Enterprise plan billing” for this organization on its Features page to start an Enterprise trial.</p>
          : <div><DenButton size="sm" onClick={openDialog} data-testid="admin-enterprise-trial-start">Start enterprise trial</DenButton></div>}
    </div>}

    {error && !draft ? <p role="alert" className="mt-3 text-xs text-red-700">{error}</p> : null}

    <Dialog.Root open={draft !== null} onOpenChange={(open) => { if (!open && !saving) setDraft(null); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/20" />
        <Dialog.Popup
          data-testid="admin-enterprise-trial-dialog"
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-gray-100 bg-white p-5 outline-none"
        >
          {draft ? <>
            <Dialog.Title className="text-[16px] font-semibold leading-6 text-gray-900">{trial ? "Change enterprise trial" : "Start enterprise trial"}</Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] leading-5 text-gray-500">
              The organization gets every Enterprise feature until the end date. Its users, members plus pending invitations, are limited to the seats you set.
            </Dialog.Description>
            <form className="mt-5 grid gap-4" onSubmit={(event) => void save(event)}>
              <label className="grid gap-1.5 text-[12px] font-medium text-gray-700">
                Seats
                <DenInput aria-label="Trial seats" type="number" min={MIN_TRIAL_SEATS} max="100000" step="1" required autoFocus value={draft.seats} disabled={saving} onChange={(event) => setDraft({ ...draft, seats: event.target.value })} />
                <span className="font-normal text-gray-500">{data.users} {data.users === 1 ? "user" : "users"} now. This becomes the Free plan user limit during the trial.</span>
              </label>
              <label className="grid gap-1.5 text-[12px] font-medium text-gray-700">
                Expiry date
                <DenInput aria-label="Trial expiry date" type="date" min={today} required value={draft.endsOn} disabled={saving} onChange={(event) => setDraft({ ...draft, endsOn: event.target.value })} />
                <span className="font-normal text-gray-500">The trial ends at the end of this day, in your time zone.</span>
              </label>
              {Number.isInteger(seatsNumber) && seatsNumber >= MIN_TRIAL_SEATS && seatsNumber < data.users
                ? <p className="text-[12px] text-amber-700">Fewer seats than current users: nobody is removed, but no one new can be invited until users drop below {seatsNumber}.</p>
                : null}
              {error ? <p role="alert" className="text-[12px] text-red-600">{error}</p> : null}
              <div className="flex justify-end gap-2">
                <Dialog.Close disabled={saving} className={buttonVariants({ variant: "secondary", size: "sm" })}>Cancel</Dialog.Close>
                <DenButton type="submit" size="sm" loading={saving} data-testid="admin-enterprise-trial-save">{trial ? "Save changes" : "Start trial"}</DenButton>
              </div>
            </form>
          </> : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  </section>;
}
