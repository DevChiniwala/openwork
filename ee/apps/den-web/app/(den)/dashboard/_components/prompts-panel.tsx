"use client";

import { useState } from "react";
import { Lock, Pencil } from "lucide-react";
import { ORG_PROMPT_MAX_LENGTH, type OrgPrompt } from "@openwork/types/den/prompts";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenTextarea } from "../../_components/ui/textarea";
import { getOrgAccessFlags, orgFeatureEnabled, permissionLockReason, type DenOrgContext } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useDenToast } from "./den-toast";
import { ConfirmDialog } from "./item-list";
import { usePromptSettings, useRemovePrompt, useSavePrompt } from "./prompts-data";

const PROMPT_DESCRIPTION = "Set the system prompt to guide and steer all the work agents carry out";
const EVERYONE_PROMPT_NOTE = "This prompt applies to everyone in the org, team specific prompts will be appended";
const PROMPT_ROWS = 15;
const promptFieldClass = "font-mono text-[13px] leading-5 overflow-y-scroll";

/** The Prompts tab shows for people who can view prompts while the Prompts feature is on. */
export function promptsTabVisible(orgContext: DenOrgContext | null): boolean {
  if (!orgContext || !orgFeatureEnabled(orgContext, "orgPrompts")) return false;
  return getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions).canViewPrompts;
}

/**
 * Members › Teams › a team (or Everyone) › Prompts: the scope's system prompt,
 * read-only until Edit. Saving creates the prompt and assigns it to the scope.
 */
export function PromptsPanel({ team }: { team: { id: string; name: string } | null }) {
  const { orgId } = useOrgDashboard();
  const settings = usePromptSettings(orgId ?? "", Boolean(orgId));

  if (!orgId || settings.isPending) return <PromptsSkeleton />;
  if (settings.isError) {
    return (
      <DenNotice
        tone="error"
        message={settings.error instanceof Error && settings.error.message ? settings.error.message : "Couldn't load prompts."}
        action={<DenButton variant="secondary" size="sm" onClick={() => void settings.refetch()}>Try again</DenButton>}
      />
    );
  }

  const prompt = team ? settings.data.teams.find((entry) => entry.teamId === team.id)?.prompt ?? null : settings.data.everyone;
  return (
    <PromptEditor
      key={`${team?.id ?? "everyone"}-${prompt?.updatedAt ?? "none"}`}
      orgId={orgId}
      teamId={team?.id ?? null}
      prompt={prompt}
      everyonePrompt={team ? settings.data.everyone : null}
      canEdit={settings.data.canEdit}
    />
  );
}

function PromptEditor({ orgId, teamId, prompt, everyonePrompt, canEdit }: {
  orgId: string;
  teamId: string | null;
  prompt: OrgPrompt | null;
  /** Shown above a team's prompt: the prompt for everyone, which comes first. */
  everyonePrompt: OrgPrompt | null;
  canEdit: boolean;
}) {
  const save = useSavePrompt(orgId);
  const remove = useRemovePrompt(orgId);
  const toast = useDenToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const editing = draft !== null;
  const saved = prompt?.content ?? "";
  const value = draft ?? saved;
  const empty = value.trim().length === 0;
  const dirty = editing && draft !== saved;

  async function submit() {
    if (draft === null || empty) return;
    setError(null);
    try {
      await save.mutateAsync({ teamId, content: draft });
      setDraft(null);
      toast({ title: "Prompt saved" });
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "Couldn't save the prompt. Try again.");
    }
  }

  function cancel() {
    setDraft(null);
    setError(null);
  }

  const actions = editing ? (
    <div className="flex items-center gap-2">
      <DenButton variant="secondary" size="sm" onClick={cancel} disabled={save.isPending}>Cancel</DenButton>
      <DenButton size="sm" onClick={() => void submit()} loading={save.isPending} disabled={!dirty || empty} data-testid="prompt-save-top">Save prompt</DenButton>
    </div>
  ) : canEdit ? (
    <DenButton variant="secondary" size="sm" icon={Pencil} onClick={() => setDraft(saved)} data-testid="prompt-edit">
      {prompt ? "Edit" : "Add prompt"}
    </DenButton>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-gray-500" title={permissionLockReason("prompts.manage")}>
      <Lock className="size-3.5" aria-hidden="true" />
      {permissionLockReason("prompts.manage")}
    </span>
  );

  return (
    <section className="flex flex-col gap-4" data-testid="prompts-panel">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-[13px] leading-6 text-gray-600">{PROMPT_DESCRIPTION}</p>
        {actions}
      </div>

      {everyonePrompt ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[12px] text-gray-500">{EVERYONE_PROMPT_NOTE}</p>
          <DenTextarea
            aria-label="Prompt for everyone"
            value={everyonePrompt.content}
            readOnly
            disabled
            rows={5}
            className={promptFieldClass}
            data-testid="prompt-everyone"
          />
        </div>
      ) : null}

      <DenTextarea
        aria-label={teamId ? "Team prompt" : "Prompt for everyone"}
        value={value}
        readOnly={!editing}
        onChange={(event) => setDraft(event.target.value)}
        maxLength={ORG_PROMPT_MAX_LENGTH}
        rows={PROMPT_ROWS}
        placeholder={editing ? "Describe how agents should work, what to prioritise and what to avoid." : "No prompt yet."}
        className={`${promptFieldClass} ${editing ? "" : "!bg-gray-50 text-gray-700"}`}
        data-testid="prompt-content"
      />

      {error ? <DenNotice tone="error" message={error} /> : null}

      {editing ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {prompt ? (
            <DenButton variant="destructive" size="sm" onClick={() => setConfirmingRemove(true)} disabled={save.isPending}>Remove prompt</DenButton>
          ) : <span />}
          <div className="flex items-center gap-2">
            <DenButton variant="secondary" size="sm" onClick={cancel} disabled={save.isPending}>Cancel</DenButton>
            <DenButton size="sm" onClick={() => void submit()} loading={save.isPending} disabled={!dirty || empty} data-testid="prompt-save-bottom">Save prompt</DenButton>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        confirm={confirmingRemove ? {
          title: "Remove this prompt?",
          description: teamId
            ? "Agents for this team's members stop following it at their next sync. The prompt for everyone still applies."
            : "Agents for everyone in the organization stop following it at their next sync. Teams' prompts still apply.",
          action: "Remove prompt",
        } : null}
        destructive
        onConfirm={async () => {
          await remove.mutateAsync(teamId);
          setDraft(null);
          toast({ title: "Prompt removed" });
        }}
        onClose={() => setConfirmingRemove(false)}
      />
    </section>
  );
}

function PromptsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <div className="flex items-center justify-between gap-4">
        <DenSkeleton className="h-4 w-80" />
        <DenSkeleton className="h-8 w-20" />
      </div>
      <DenSkeleton className="h-[320px] w-full rounded-lg" />
    </div>
  );
}
