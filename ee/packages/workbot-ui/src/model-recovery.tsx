"use client";

import { useQuery } from "@tanstack/react-query";
import { workbotModelRecoverySchema } from "@openwork/types/den/workbot-settings";
import { ExternalLink, Lock } from "lucide-react";
import type { WorkbotTurn } from "./data";
import { workbotHost } from "./host";

/** Desktop Auto's signed-in intent: explain the limit, keep the work, offer an explicit next action. */
export function ModelRecovery({ issue, onRetry }: { issue: NonNullable<WorkbotTurn["modelIssue"]>; onRetry?: () => void }) {
  const host = workbotHost();
  const destination = host.usageRecovery;
  const blocked = host.documentAuthorization !== undefined;
  const recovery = useQuery({
    queryKey: ["workbot", "model-recovery", host.identity?.principalId, host.identity?.organizationId],
    enabled: Boolean(destination && host.identity && !blocked),
    queryFn: async () => {
      const { response, payload } = await host.requestJson("/v1/workbot/model-recovery", { method: "GET" });
      if (!response.ok) throw new Error("Couldn't check model access.");
      return workbotModelRecoverySchema.parse(payload);
    },
    staleTime: 0,
    retry: false,
  });
  if (!destination || blocked) return null;
  const options = recovery.isError ? undefined : recovery.data;
  const action = issue === "free_limit" && options?.canUpgrade ? { label: "Upgrade models", path: "ai-gateway?tab=openwork-models" }
    : issue === "payment_required" && options?.canManageBilling ? { label: "Manage billing", path: "billing" }
    : options?.canManageModels ? { label: "Change Workbot's model", path: "workbot-settings" } : null;
  const url = action ? `${destination.denUrl}/dashboard/${action.path}${action.path.includes("?") ? "&" : "?"}workbotOrganizationId=${encodeURIComponent(destination.organizationId)}` : null;
  const reset = issue === "free_limit" && options?.freeExhausted && options.freeResetsAt
    ? new Date(options.freeResetsAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : null;
  const message = issue === "free_limit" ? `You've used the free model allowance for now.${reset ? ` It resets ${reset}.` : ""}`
    : issue === "usage_limit" ? "Your workspace's model usage limit has been reached. Ask a workspace admin for more allowance or another model."
    : "OpenWork Models needs a billing update before this answer can continue.";
  const linkClass = "inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";
  return <div role="status" data-testid="workbot-model-recovery" className="mt-3 flex items-start gap-2 text-[13px] text-[var(--wb-muted)]">
    <Lock size={14} className="mt-1 shrink-0" aria-hidden />
    <div className="min-w-0">
      <p>{message}</p>
      {issue === "free_limit" && options && <p className="mt-1 text-[12px]">{options.canUpgrade ? "Paid models have separate limits. An admin can change Workbot's model." : "Ask a workspace admin to choose another model to keep going."}</p>}
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
