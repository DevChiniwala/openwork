import { readOrgSelectionPending } from "@/app/lib/den-sign-in-intent";
import { claimSignInReturnDraft, readSignInReturnTarget, type SignInReturnTarget } from "@/app/lib/den-sign-in-return";
import {
  clearSessionDraft,
  cloudSessionDraftScope,
  getSessionDraft,
  LOCAL_SESSION_DRAFT_SCOPE,
  NEW_TASK_DRAFT_SESSION_ID,
  saveSessionDraft,
  type SessionDraftIdentity,
} from "../session/sync/draft-store";

/** Move one signed-out draft into the signed-in scope, never over a draft already there. */
export function carrySignedOutDraft(target: Pick<SignInReturnTarget, "workspaceId" | "sessionId">, scope: string) {
  if (!target.workspaceId) return false;
  const slot = target.sessionId ?? NEW_TASK_DRAFT_SESSION_ID;
  const signedOut = getSessionDraft(LOCAL_SESSION_DRAFT_SCOPE, target.workspaceId, slot);
  if (!signedOut?.text.trim()) return false;
  if (getSessionDraft(scope, target.workspaceId, slot)?.text.trim()) return false;
  const saved = saveSessionDraft(scope, target.workspaceId, slot, { text: signedOut.text, mode: signedOut.mode });
  if (saved.status !== "saved") return false;
  clearSessionDraft(LOCAL_SESSION_DRAFT_SCOPE, target.workspaceId, slot);
  return true;
}

/**
 * Drafts are stored per account and organization. The auth provider calls
 * this with a newly verified identity, before publishing it, so the draft of
 * the conversation a desktop-initiated sign-in (`desktopSignInReturn`)
 * started from is already in the signed-in scope when the composer switches
 * to it. Runs once per sign-in; a no-op without a completed target.
 */
export function carrySignInReturnDraft(identity: SessionDraftIdentity): boolean {
  const target = readSignInReturnTarget();
  if (!target || target.signedInAt === null || target.draftCarried) return false;
  if (readOrgSelectionPending().pending) return false;
  const scope = cloudSessionDraftScope(identity);
  if (!scope) return false;
  const claimed = claimSignInReturnDraft();
  return claimed ? carrySignedOutDraft(claimed, scope) : false;
}
