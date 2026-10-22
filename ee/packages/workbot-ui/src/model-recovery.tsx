"use client";

import { useQuery } from "@tanstack/react-query";
import { workbotModelRecoverySchema, type WorkbotAccessReason } from "@openwork/types/den/workbot-settings";
import { ExternalLink, Lock } from "lucide-react";
import type { WorkbotTurn } from "./data";
import { workbotHost } from "./host";

function useRecoveryOptions() {
  const host = workbotHost();
  return useQuery({
    queryKey: ["workbot", "model-recovery", host.identity?.principalId, host.identity?.organizationId],
    enabled: Boolean(host.usageRecovery && host.identity && host.documentAuthorization === undefined),
    queryFn: async () => {
      const { response, payload } = await host.requestJson("/v1/workbot/model-recovery", { method: "GET" });
      if (!response.ok) throw new Error("Couldn't check model access.");
      return workbotModelRecoverySchema.parse(payload);
    },
    staleTime: 0,
    refetchOnWindowFocus: "always",
    retry: false,
  });
}

const linkClass = "inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";

function managementUrl(path: string) {
  const destination = workbotHost().usageRecovery;
  return destination ? `${destination.denUrl}/dashboard/${path}${path.includes("?") ? "&" : "?"}workbotOrganizationId=${encodeURIComponent(destination.organizationId)}` : null;
}

/** Desktop Auto intent, after login: confirm the allowance and a usable paid route before offering checkout. */
export function ModelRecovery({ issue, onRetry }: { issue: NonNullable<WorkbotTurn["modelIssue"]>; onRetry?: () => void }) {
  const host = workbotHost();
  const recovery = useRecoveryOptions();
  if (!host.usageRecovery || host.documentAuthorization !== undefined) return null;
  const options = recovery.isError ? undefined : recovery.data;
  const confirmedFree = issue === "free_limit" && options?.freeExhausted === true;
  const offerUpgrade = confirmedFree && options?.canUpgrade && options.purchaseEligible && options.paidContinuation === "after_upgrade" && options.upgradeBlockedReason === null;
  const paidReady = issue === "free_limit" && options?.managedLuna && options.paidContinuation === "authorized";
  const action = offerUpgrade ? { label: "Upgrade models", path: "ai-gateway?tab=openwork-models" }
    : issue === "payment_required" && options?.canManageBilling ? { label: "Manage billing", path: "billing" }
    : !options?.managedLuna && options?.canManageModels ? { label: "Change Workbot's model", path: "workbot-settings" } : null;
  const url = action ? managementUrl(action.path) : null;
  const reset = issue === "free_limit" && options?.freeExhausted && options.freeResetsAt
    ? new Date(options.freeResetsAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : null;
  const message = issue === "free_limit" ? confirmedFree ? `You've used the free model allowance for now.${reset ? ` It resets ${reset}.` : ""}` : "Workbot's model access needs checking."
    : issue === "usage_limit" ? "Your workspace's model usage limit has been reached. Ask a workspace admin for more allowance or another model."
    : "OpenWork Models needs a billing update before this answer can continue.";
  return <div role="status" data-testid="workbot-model-recovery" className="mt-3 flex items-start gap-2 text-[13px] text-[var(--wb-muted)]">
    <Lock size={14} className="mt-1 shrink-0" aria-hidden />
    <div className="min-w-0">
      <p>{message}</p>
      {issue === "free_limit" && options && <p className="mt-1 text-[12px]">{paidReady ? "Paid Luna is ready. Your next message in this conversation uses your Models subscription. Auto’s free allowance stays separate." : offerUpgrade ? "Upgrade to keep using Luna through your Models subscription. Return here and check access before continuing." : options.managedLuna && options.hasModelsSubscription ? "Your Models access isn’t ready yet. Check access again shortly, or ask someone with billing access to review your subscription." : options.managedLuna ? "Ask someone with billing access to upgrade Models, or wait for Auto’s free allowance to reset." : "Ask a workspace admin to choose an available model to keep going."}</p>}
      {!options?.managedLuna && options?.canManageModels && <p className="mt-1 text-[12px]">After changing models, send a new message in this conversation. Retrying an answer keeps its original model.</p>}
      {issue === "payment_required" && options && !action && <p className="mt-1 text-[12px]">Someone with billing access can update the payment details.</p>}
      <div className="-ml-2 mt-1 flex flex-wrap items-center gap-1">
        {action && url && <a className={linkClass} href={url} target="_blank" rel="noopener noreferrer">{action.label}<ExternalLink size={12} aria-label="Opens in a new tab" /></a>}
        {recovery.isError ? <button type="button" className={linkClass} onClick={() => void recovery.refetch()}>Check recovery options</button>
          : onRetry && options && (issue === "free_limit" && options.freeExhausted
            ? <button type="button" className={linkClass} disabled={recovery.isFetching} onClick={() => void recovery.refetch()}>Check access</button>
            : <button type="button" className={linkClass} onClick={onRetry}>Try again</button>)}
      </div>
      {recovery.isError && <p className="text-[12px]">Couldn't check your recovery options.</p>}
    </div>
  </div>;
}

/** A Den refusal happens before execution. Preserve the pending message and retry only on the person's action. */
export function AccessRecovery({ reason, onRetry }: { reason: WorkbotAccessReason; onRetry?: () => void }) {
  const host = workbotHost();
  const recovery = useRecoveryOptions();
  if (host.documentAuthorization !== undefined) return null;
  const copy: Record<WorkbotAccessReason, string> = {
    gateway_not_configured: "Model access hasn’t been set up for Workbot. Ask a workspace admin to finish setup.",
    gateway_provider_missing: "Your workspace has no available model provider for Workbot. Ask a workspace admin to add one.",
    gateway_member_access_missing: "You haven’t been granted access to Workbot’s selected model. Ask a workspace admin for access.",
    gateway_model_unavailable: "Workbot’s saved model is no longer available. Ask a workspace admin to choose an available model.",
    gateway_authentication_required: "Workbot’s model needs an account connection. Ask a workspace admin to check the model’s connection requirements.",
    gateway_credentials_unavailable: "Workbot’s model credentials need attention. Ask a workspace admin to check the model connection.",
    oauth_scope_missing: "Your sign-in doesn’t include permission to run Workbot. Sign in again to review access.",
    managed_models_setup_required: "Your Models access isn’t ready. Check access again shortly, or ask a workspace admin to review Models setup.",
    model_access_unavailable: "Workbot can’t access its selected model. Ask a workspace admin to check model access.",
    rate_limited: "Model access is temporarily limited. Wait a minute, then try again.",
  };
  const managed = recovery.data?.managedLuna === true;
  const settings = recovery.data?.canManageModels ? managementUrl(managed ? "ai-gateway?tab=openwork-models" : "workbot-settings") : null;
  const signIn = host.signInHref ? new URL(host.signInHref, window.location.href) : null;
  if (signIn) signIn.searchParams.set("workspace", "choose");
  const action = reason === "oauth_scope_missing" && signIn ? { href: signIn.toString(), label: "Review sign-in access" }
    : reason !== "rate_limited" && settings ? { href: settings, label: managed ? "Review Models access" : "Review Workbot’s model" } : null;
  return <div role="status" data-testid="workbot-access-recovery" className="mt-3 text-[13px] text-[var(--wb-muted)]">
    <p>{copy[reason]}</p>
    <div className="-ml-2 mt-1 flex flex-wrap items-center gap-1">
      {action && <a className={linkClass} href={action.href} target="_blank" rel="noopener noreferrer">{action.label}<ExternalLink size={12} aria-label="Opens in a new tab" /></a>}
      {onRetry && <button type="button" className={linkClass} onClick={onRetry}>{reason === "rate_limited" ? "Try again" : "Check access and retry"}</button>}
    </div>
  </div>;
}
