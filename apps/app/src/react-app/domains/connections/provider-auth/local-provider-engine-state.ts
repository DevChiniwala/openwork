import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EngineV2PreviewStatus, OpenworkServerClient } from "@/app/lib/openwork-server";
import { isCloudManagedProviderKey } from "./cloud-provider-config";

/**
 * How a provider on this device stands on the engine chat runs on, when it
 * cannot be used there. A provider without one is ready.
 * - `managed_by_organization`: the organization allows only its own providers.
 * - `not_on_engine`: OpenCode v2 cannot use it yet (a sign-in, or no adapter).
 */
export type LocalProviderEngineState = "managed_by_organization" | "not_on_engine";

export type LocalProviderEngineStatus = Pick<EngineV2PreviewStatus, "enabled" | "chatRouting" | "skippedProviders">;

/**
 * Read from the server's skipped list, never guessed: a provider OpenCode v2
 * skipped is never "Ready to use". Only while chat runs on v2 and the server
 * explains its skips (the `localProviderMirror` rollout); otherwise nothing
 * changes. Organization providers keep their own rows and states.
 */
export function localProviderEngineStates(status: LocalProviderEngineStatus | null | undefined): ReadonlyMap<string, LocalProviderEngineState> {
  if (!status?.enabled || !status.chatRouting || !status.skippedProviders) return new Map();
  return new Map(status.skippedProviders.flatMap((provider): Array<[string, LocalProviderEngineState]> =>
    isCloudManagedProviderKey(provider.id)
      ? []
      : [[provider.id, provider.reason === "policy" ? "managed_by_organization" : "not_on_engine"]]));
}

/**
 * The engine states for Settings › AI Providers. `refreshKey` changes when the
 * connected providers do; the server finishes mirroring a saved key before
 * the save returns, so the next read already explains it.
 */
export function useLocalProviderEngineStates(client: OpenworkServerClient | null, refreshKey: string): ReadonlyMap<string, LocalProviderEngineState> {
  const status = useQuery({
    queryKey: ["local-provider-engine-states", client?.baseUrl ?? "", client?.token ?? "", refreshKey],
    queryFn: () => (client ? client.getEngineV2PreviewStatus() : null),
    enabled: Boolean(client),
    staleTime: 30_000,
    retry: false,
  });
  return useMemo(() => localProviderEngineStates(status.data), [status.data]);
}
