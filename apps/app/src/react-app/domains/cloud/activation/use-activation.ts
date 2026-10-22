import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ActivationClientEvent, ActivationState } from "@openwork/types/den/activation";
import { createDenClient, denOriginComparisonKey } from "@/app/lib/den";
import { readGatewayUsageScope, subscribeGatewayUsageScope } from "@/app/lib/gateway-usage-scope";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { useDenAuth } from "../den-auth-provider";
import { createActivationReporter, draftUsesSkill } from "./activation-model";

/**
 * The signed-in person's Get set up checklist from Den (`GET /v1/me/activation`). Den answers 404 while the
 * `activationChecklist` feature is off; the client then has no checklist and reports nothing.
 */

type DenScope = ReturnType<typeof readGatewayUsageScope>;

function activationQueryPrefix(scope: Pick<DenScope, "baseUrl" | "organizationId">) {
  return ["den-activation", denOriginComparisonKey(scope.baseUrl), scope.organizationId ?? null] as const;
}

function clientFor(scope: DenScope) {
  return createDenClient({ baseUrl: scope.baseUrl, apiBaseUrl: scope.apiBaseUrl, token: scope.token });
}

export function useActivation() {
  const auth = useDenAuth();
  const scope = useSyncExternalStore(subscribeGatewayUsageScope, readGatewayUsageScope, readGatewayUsageScope);
  const organizationId = scope.organizationId;
  const authorized = Boolean(auth.isSignedIn && scope.token && organizationId && auth.verifiedIdentity?.organizationId === organizationId);
  const query = useQuery({
    queryKey: [...activationQueryPrefix(scope), auth.verifiedIdentity?.principalId ?? null],
    enabled: authorized,
    queryFn: async (): Promise<ActivationState | null> => (organizationId ? clientFor(scope).getActivation(organizationId) : null),
    staleTime: 30_000,
    refetchOnWindowFocus: "always",
    retry: false,
  });
  return { state: authorized ? query.data ?? null : null, refetch: query.refetch };
}

type ReporterScope = DenScope & { key: string; prefix: readonly unknown[] };

const report = createActivationReporter<ReporterScope>({
  readState: (scope) => getReactQueryClient().getQueriesData<ActivationState | null>({ queryKey: scope.prefix }).map(([, data]) => data).find((data) => data !== undefined),
  send: (scope, step, durationMs) => scope.organizationId
    ? clientFor(scope).recordActivationEvent(scope.organizationId, { step, ...(durationMs !== undefined ? { durationMs: Math.min(Math.max(0, Math.round(durationMs)), 24 * 60 * 60 * 1000) } : {}) })
    : Promise.resolve(null),
  onState: (scope, state) => { getReactQueryClient().setQueriesData<ActivationState | null>({ queryKey: scope.prefix }, state); },
});

/** Reports a step only this app can observe, while Den shows the checklist; never throws. */
export function reportActivationEvent(step: ActivationClientEvent, durationMs?: number): Promise<boolean> {
  const scope = readGatewayUsageScope();
  if (!scope.token || !scope.organizationId) return Promise.resolve(false);
  const prefix = activationQueryPrefix(scope);
  return report({ ...scope, prefix, key: JSON.stringify(prefix) }, step, durationMs);
}

const skillRuns = new Set<string>();

/** A message was sent: remember whether it runs a skill, to report once its answer completes. */
export function noteActivationRunStarted(sessionId: string, parts: readonly { type: string }[] | undefined) {
  if (draftUsesSkill(parts)) skillRuns.add(sessionId);
}

/** An answer completed: the first answer (with how long it took) and, if the message ran a skill, using a skill. */
export function noteActivationRunCompleted(sessionId: string, durationMs: number) {
  void reportActivationEvent("first_response", durationMs);
  if (skillRuns.delete(sessionId)) void reportActivationEvent("use_skill");
}
