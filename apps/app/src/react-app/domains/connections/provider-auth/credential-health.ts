import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";

export type ProviderCredentialHealth = "unverified" | "verified" | "rejected";

const entrySchema = z.object({
  status: z.enum(["verified", "rejected"]),
  revision: z.number(),
});
const persistedSchema = z.object({
  entries: z.record(z.string(), entrySchema),
  revisions: z.record(z.string(), z.number()),
  configurations: z.record(z.string(), z.string()).default({}),
});

/** Evidence belongs to the workspace's runtime provider, never its display name. */
export function credentialHealthKey(workspaceId: string, providerId: string): string {
  return JSON.stringify([workspaceId, providerId]);
}

type CredentialHealthState = {
  entries: Record<string, z.infer<typeof entrySchema>>;
  revisions: Record<string, number>;
  configurations: Record<string, string>;
  configure: (workspaceId: string, providerId: string, version: string) => void;
  changed: (workspaceId: string, providerId: string) => void;
  observe: (workspaceId: string, providerId: string, status: "verified" | "rejected", startedAt: number) => void;
};

/** Only the outcome is retained. No keys, error text, response bodies or model output. */
export const useProviderCredentialHealth = create<CredentialHealthState>()(persist((set) => ({
  entries: {},
  revisions: {},
  configurations: {},
  configure: (workspaceId, providerId, version) => {
    const key = credentialHealthKey(workspaceId, providerId);
    const previous = useProviderCredentialHealth.getState().configurations[key];
    if (previous !== undefined && previous !== version) useProviderCredentialHealth.getState().changed(workspaceId, providerId);
    set((state) => ({ configurations: { ...state.configurations, [key]: version } }));
  },
  changed: (workspaceId, providerId) => set((state) => {
    const key = credentialHealthKey(workspaceId, providerId);
    const entries = { ...state.entries };
    delete entries[key];
    return { entries, revisions: { ...state.revisions, [key]: Date.now() } };
  }),
  observe: (workspaceId, providerId, status, startedAt) => set((state) => {
    const key = credentialHealthKey(workspaceId, providerId);
    const revision = state.revisions[key] ?? 0;
    // A request already in flight when a key was replaced cannot bless or
    // reject the replacement. Equal timestamps are conservatively ignored.
    if (revision >= startedAt) return state;
    return { entries: { ...state.entries, [key]: { status, revision } } };
  }),
}), {
  name: "openwork.provider-credential-health.v1",
  storage: createJSONStorage(() => localStorage),
  partialize: ({ entries, revisions, configurations }) => ({ entries, revisions, configurations }),
  merge: (persisted, current) => {
    const parsed = persistedSchema.safeParse(persisted);
    return parsed.success ? { ...current, ...parsed.data } : current;
  },
}));
