"use client";

import { useState } from "react";
import { getLibraryAddConnectorRoute, getLibraryConnectorRoute, getLibraryMyAgentRoute, getLibraryRoute, orgFeatureEnabled, type DenOrgContext } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { ItemHeader, ItemPage } from "./item-header";
import { useLibrary, type LibraryConnectionItem, type LibraryItem } from "./library-data";
import { MyAgentPanel, MyAgentPanelSkeleton, MyAgentRow, MyAgentRowError, MyAgentRowSkeleton, type MyAgentLinks } from "./my-agent";
import { useMyAgent, useMyAgentChecks, useSaveMyAgent } from "./my-agent-data";

/** My agent shows where Your agent runs (Workbot on this deployment) and both rollouts are on for the member. */
export function myAgentAvailable(orgContext: DenOrgContext | null | undefined): boolean {
  return orgContext?.capabilities.workbot === true
    && orgFeatureEnabled(orgContext, "workbotProactive")
    && orgFeatureEnabled(orgContext, "workbotAgentLibrary");
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

/** The Library row, pinned above the filters. */
export function MyAgentLibraryEntry() {
  const { orgSlug, orgContext } = useOrgDashboard();
  const orgId = orgContext?.organization.id ?? "";
  const agent = useMyAgent(orgId);
  const save = useSaveMyAgent(orgId);
  if (agent.isError) return <MyAgentRowError message={errorMessage(agent.error, "Couldn't load your agent.")} retrying={agent.isFetching} onRetry={() => void agent.refetch()} />;
  if (!agent.data) return <MyAgentRowSkeleton />;
  return <MyAgentRow view={agent.data} href={getLibraryMyAgentRoute(orgSlug)} now={Date.now()} saving={save.isPending} onToggle={(on) => save.mutate({ on })} />;
}

function isConnection(item: LibraryItem): item is LibraryConnectionItem {
  return item.type === "connection";
}

const CONNECTION_STATUS: Record<LibraryConnectionItem["state"], string> = {
  connected: "Ready",
  needs_signin: "Sign in",
  needs_admin_setup: "Needs admin setup",
  available: "Not connected",
};

/** Library › My agent. */
export function MyAgentScreen() {
  const { orgSlug, orgContext } = useOrgDashboard();
  const orgId = orgContext?.organization.id ?? "";
  const available = myAgentAvailable(orgContext);
  const agent = useMyAgent(orgId, available);
  const library = useLibrary();
  const save = useSaveMyAgent(orgId);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const earlier = useMyAgentChecks(orgId, available && earlierOpen);
  const libraryHref = getLibraryRoute(orgSlug);
  const back = { href: libraryHref, label: "My Library" };

  if (!available) return <ItemPage><ItemHeader back={back} title="Not in your Library" description="Your organization hasn't turned on My agent for you." /></ItemPage>;
  if (agent.isError) return <ItemPage><ItemHeader back={back} title="It did not load" description={`${errorMessage(agent.error, "Couldn't load your agent.")} Reload the page to try again.`} /></ItemPage>;
  if (!agent.data) return <MyAgentPanelSkeleton library={libraryHref} />;

  const connections = (library.data ?? []).filter(isConnection);
  const google = connections.find((item) => item.provider === "google-workspace");
  const slack = connections.find((item) => item.name.trim().toLowerCase() === "slack");
  const links: MyAgentLinks = {
    library: libraryHref,
    google: google
      ? { href: getLibraryConnectorRoute(orgSlug, google.id), status: CONNECTION_STATUS[google.state] }
      : { href: getLibraryAddConnectorRoute(orgSlug, "google-workspace"), status: library.isLoading ? "" : "Not added" },
    slack: { href: slack ? getLibraryConnectorRoute(orgSlug, slack.id) : null },
  };

  return (
    <MyAgentPanel
      view={agent.data}
      now={Date.now()}
      links={links}
      saving={save.isPending}
      error={save.isError ? errorMessage(save.error, "Couldn't save. Try again.") : null}
      earlier={{
        open: earlierOpen,
        onToggle: setEarlierOpen,
        checks: earlier.data ?? null,
        loading: earlier.isLoading && earlierOpen,
        error: earlier.isError ? errorMessage(earlier.error, "Couldn't load this week's checks.") : null,
      }}
      onChange={(change) => save.mutate(change)}
    />
  );
}
