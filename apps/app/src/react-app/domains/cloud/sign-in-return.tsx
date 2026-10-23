/** @jsxImportSource react */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { NavigateFunction } from "react-router";

import { buildDenAuthUrl, createDenClient, readDenBootstrapConfig, readDenSettings } from "@/app/lib/den";
import { markDesktopSignInInitiated } from "@/app/lib/den-sign-in-intent";
import {
  beginSignInReturn,
  claimSignInReturnRoute,
  clearSignInReturnTarget,
  currentAppRoutePath,
  parseSignInReturnTarget,
  readSignInReturnRaw,
  readSignInReturnTarget,
  recordSignInReturnTarget,
  subscribeSignInReturn,
  type BeginSignInResult,
  type SignInReturnTarget,
} from "@/app/lib/den-sign-in-return";
import { toast } from "@/components/ui/sonner";
import { usePlatform } from "@/react-app/kernel/platform";
import { useDenAuth } from "./den-auth-provider";

const FEATURE_KEY = "desktopSignInReturn";
const FEATURE_STALE_MS = 30_000;

export function signInReturnFeatureQueryKey(baseUrl: string) {
  return ["den", "deployment-features", "sign-in-return", baseUrl] as const;
}

/**
 * The `desktopSignInReturn` feature. People who can sign in have no
 * organization yet, so it is the deployment switch (`GET /v1/features`),
 * revalidated with Den rather than served from the HTTP cache so a kill
 * switch applies to the next sign-in. Unreachable or missing means off.
 */
export function useSignInReturnFeature(): boolean {
  const auth = useDenAuth();
  const baseUrl = readDenSettings().baseUrl;
  const client = useMemo(() => createDenClient({ baseUrl }), [baseUrl]);
  const signedOut = auth.status === "signed_out";
  const query = useQuery({
    queryKey: signInReturnFeatureQueryKey(baseUrl),
    queryFn: () => client.getDeploymentFeatures({ cache: "no-cache" }),
    enabled: signedOut,
    staleTime: FEATURE_STALE_MS,
    retry: false,
    select: (features) => features[FEATURE_KEY] === true,
  });
  return signedOut && !query.isError && query.data === true;
}

export type CloudSignInRequest = {
  /** A message the person sent is waiting to be resent after sign-in. */
  pendingTurn?: boolean;
  /** The browser link to open; defaults to Den's sign-up/sign-in page. */
  url?: string;
  /** The entry point's existing behaviour, used while the feature is off. */
  fallback?: () => void;
  /** The conversation on screen when the route does not name it. */
  workspaceId?: string | null;
  sessionId?: string | null;
};

function defaultAuthUrl() {
  // Label stays "Sign in"; opens the sign-up tab so new users aren't defaulted into sign-in.
  return buildDenAuthUrl(readDenBootstrapConfig().baseUrl, "sign-up");
}

/**
 * Starts sign-in from wherever the person is. With `desktopSignInReturn`
 * on, the route stays on screen while the browser finishes, and sign-in
 * comes back here. Off, every entry point keeps its current behaviour.
 */
export function useCloudSignIn() {
  const platform = usePlatform();
  const enabled = useSignInReturnFeature();
  return useCallback((request: CloudSignInRequest = {}): BeginSignInResult => {
    const url = request.url ?? defaultAuthUrl();
    return beginSignInReturn(
      { path: currentAppRoutePath(), workspaceId: request.workspaceId, sessionId: request.sessionId, pendingTurn: request.pendingTurn, authUrl: url },
      {
        enabled,
        openLink: (link) => platform.openLink(link),
        markDesktopSignInInitiated: () => markDesktopSignInInitiated(),
        fallback: request.fallback ?? (() => {
          markDesktopSignInInitiated();
          platform.openLink(url);
        }),
      },
    );
  }, [enabled, platform]);
}

/**
 * A code pasted from the account menu completes in place; with the feature
 * on, it returns to this route too. It completes a browser sign-in already
 * waiting rather than replacing it, and a failed paste leaves nothing behind.
 */
export function useRecordSignInReturnForPaste() {
  const enabled = useSignInReturnFeature();
  return useCallback((): (() => void) | undefined => {
    if (!enabled) return undefined;
    const waiting = readSignInReturnTarget();
    if (waiting && waiting.signedInAt === null) return undefined;
    const recorded = recordSignInReturnTarget({ path: currentAppRoutePath() });
    if (!recorded) return undefined;
    return () => {
      const current = readSignInReturnTarget();
      if (current?.startedAt === recorded.startedAt && current.signedInAt === null) clearSignInReturnTarget();
    };
  }, [enabled]);
}

export function useSignInReturnTarget(): SignInReturnTarget | null {
  const raw = useSyncExternalStore(subscribeSignInReturn, () => readSignInReturnRaw(), () => null);
  return useMemo(() => parseSignInReturnTarget(raw, Date.now()), [raw]);
}

/**
 * Opens the route sign-in started from, once, with "Signed in to {org}".
 * Returns false when there is nothing to return to (the caller then uses
 * its default landing).
 */
export function completeSignInReturn(navigate: NavigateFunction): boolean {
  const target = claimSignInReturnRoute();
  if (!target) return false;
  navigate(target.path, { replace: true });
  const organization = readDenSettings().activeOrgName?.trim();
  toast.success(organization ? `Signed in to ${organization}` : "Signed in", { id: "sign-in-return" });
  return true;
}
