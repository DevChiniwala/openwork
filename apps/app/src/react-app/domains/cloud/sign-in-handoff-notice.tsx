/** @jsxImportSource react */
import { useId, useState } from "react";
import { LoaderCircle } from "lucide-react";

import { clearSignInReturnTarget } from "@/app/lib/den-sign-in-return";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { useDenAuth } from "./den-auth-provider";
import { ComposerNoticeCard } from "./gateway-usage-panel";
import { useSignInReturnTarget } from "./sign-in-return";
import { useManualSignInCode } from "./use-manual-sign-in-code";

/**
 * Shown above the composer of the conversation a sign-in started from while
 * the browser finishes it (`desktopSignInReturn`). The conversation and its
 * draft stay on screen; the code fallback is always visible, not only after
 * a failure (DESIGN P11).
 */
export function SignInHandoffNotice(props: {
  workspaceId: string | null | undefined;
  sessionId: string | null | undefined;
  hasDraft: boolean;
}) {
  const auth = useDenAuth();
  const target = useSignInReturnTarget();
  const [pasteOpen, setPasteOpen] = useState(false);
  const manual = useManualSignInCode();
  const inputId = useId();
  const sessionId = props.sessionId ?? null;
  const workspaceId = props.workspaceId ?? null;
  const visible = Boolean(
    target
      && target.authUrl
      && target.signedInAt === null
      && !auth.isSignedIn
      && target.sessionId === sessionId
      && (!target.workspaceId || !workspaceId || target.workspaceId === workspaceId),
  );
  if (!visible || !target) return null;

  const detail = target.pendingTurn
    ? "Your message is saved and sends when you’re back"
    : props.hasDraft ? "Your draft is saved" : undefined;
  const authUrl = target.authUrl;
  const copyLink = () => {
    if (!authUrl) return;
    void navigator.clipboard.writeText(authUrl)
      .then(() => toast.success("Sign-in link copied"))
      .catch(() => toast.error("Couldn’t copy the sign-in link. Use a sign-in code instead."));
  };

  return (
    <div role="status" data-testid="sign-in-handoff-notice">
      <ComposerNoticeCard
        icon={<LoaderCircle className="animate-spin motion-reduce:animate-none" />}
        title="Finish signing in in your browser"
        detail={detail}
      >
        <div className="flex flex-wrap items-center gap-1 ps-7">
          {authUrl ? <Button size="sm" variant="outline" onClick={copyLink}>Copy sign-in link</Button> : null}
          <Button size="sm" variant="outline" aria-expanded={pasteOpen}
            onClick={() => setPasteOpen((open) => !open)}>
            {t("den.paste_signin_code")}
          </Button>
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => clearSignInReturnTarget()}>Cancel</Button>
        </div>
        {pasteOpen ? (
          <form
            className="flex flex-col gap-1.5 ps-7"
            onSubmit={(event) => {
              event.preventDefault();
              void manual.submit();
            }}
          >
            <label htmlFor={inputId} className="text-xs text-muted-foreground">{t("den.signin_link_label")}</label>
            <div className="flex items-center gap-2">
              <Input
                id={inputId}
                value={manual.code}
                onChange={(event) => manual.setCode(event.currentTarget.value)}
                placeholder={t("den.signin_link_placeholder")}
                disabled={manual.busy}
                autoFocus
                className="h-8 min-w-0 flex-1"
              />
              <Button type="submit" size="sm" disabled={manual.busy || !manual.code.trim()}>
                {manual.busy ? t("den.finishing") : t("den.finish_signin")}
              </Button>
            </div>
            {manual.error ? <p role="alert" className="text-xs text-destructive">{manual.error}</p> : null}
          </form>
        ) : null}
      </ComposerNoticeCard>
    </div>
  );
}
