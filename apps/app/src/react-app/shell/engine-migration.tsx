/** @jsxImportSource react */
import { useEffect, useLayoutEffect, useRef, useState, type PropsWithChildren } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import {
  createOpenworkServerClient,
  type EngineV2MigrationStatus,
  type EngineV2PreviewStatus,
  type OpenworkServerClient,
} from "@/app/lib/openwork-server";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { resolveOpenworkConnection } from "./openwork-connection";

/**
 * Observes the host copying chats saved before OpenCode v2. The local server
 * copies them on its own when it starts; this only shows that work, refreshes
 * chat lists once it finishes, and offers "Try again" when it failed.
 */

/** Dispatched on `window` once earlier chats finished copying, so chat lists reload. */
export const CHAT_HISTORY_IMPORTED_EVENT = "openwork-chat-history-imported";

export type HistoryImportClient = Pick<OpenworkServerClient, "getEngineV2PreviewStatus" | "migrateOpencodeHistory">;

export type HistoryImportView =
  | { kind: "idle" }
  | { kind: "copying"; migration: EngineV2MigrationStatus | null }
  | { kind: "error"; migration: EngineV2MigrationStatus };

export function historyImportView(status: Pick<EngineV2PreviewStatus, "historyImportPending" | "migration">): HistoryImportView {
  const migration = status.migration ?? null;
  if (status.historyImportPending === true || migration?.state === "running") return { kind: "copying", migration };
  if (migration?.state === "error") return { kind: "error", migration };
  return { kind: "idle" };
}

const formatCount = (value: number) => new Intl.NumberFormat().format(value);

/** Chats dealt with so far: copied (whole or trimmed), already copied, or left behind. */
const handledCount = (migration: EngineV2MigrationStatus) =>
  migration.imported + migration.skipped + (migration.notCopied?.length ?? 0) + (migration.trimmed?.length ?? 0);

/** Floating notices clear the actual chrome, including native offsets and taller route headers. */
function MigrationFloatingRegion(props: PropsWithChildren) {
  const regionRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    const chromeSelector = "[data-session-header], [data-settings-titlebar], [data-sidebar-titlebar], .window-titlebar";
    const observed = new Set<Element>();
    let frame: number | null = null;
    let rebindChrome = false;
    const measure = () => {
      const bottom = Math.max(0, ...Array.from(observed, (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? rect.bottom : 0;
      }));
      const value = `${bottom}px`;
      if (region.style.getPropertyValue("--engine-migration-chrome-bottom") !== value) {
        region.style.setProperty("--engine-migration-chrome-bottom", value);
      }
    };
    const scheduleMeasure = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (rebindChrome) {
          rebindChrome = false;
          refreshChrome();
        }
        measure();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    const refreshChrome = () => {
      const chrome = new Set(document.querySelectorAll(chromeSelector));
      for (const element of observed) {
        if (chrome.has(element)) continue;
        resizeObserver.unobserve(element);
        observed.delete(element);
      }
      for (const element of chrome) {
        if (observed.has(element)) continue;
        observed.add(element);
        resizeObserver.observe(element);
      }
    };
    const scheduleRefresh = () => {
      rebindChrome = true;
      scheduleMeasure();
    };
    // Only chrome replacement needs rebinding. Streaming text and app-wide
    // attribute changes must not trigger layout reads; header sizes use RO.
    const containsChrome = (node: Node) => node instanceof Element
      && (node.matches(chromeSelector) || node.querySelector(chromeSelector) !== null);
    const mutationObserver = new MutationObserver((records) => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(containsChrome))) {
        scheduleRefresh();
      }
    });
    mutationObserver.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });
    window.addEventListener("resize", scheduleMeasure);
    scheduleRefresh();
    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);
  // Above page chrome (z-40) but below dialogs, menus and the command palette (z-50), which must cover this optional notice.
  return (
    <div
      ref={regionRef}
      className="pointer-events-none fixed inset-x-0 top-[calc(max(var(--window-titlebar-height),var(--engine-migration-chrome-bottom,0px))+var(--spacing)*3)] z-[45] flex justify-center px-4"
    >
      {props.children}
    </div>
  );
}

const noticeClassName = "pointer-events-auto flex max-w-xl items-center gap-3 rounded-2xl bg-popover px-4 py-3 text-popover-foreground shadow-[var(--dls-card-shadow)] ring-1 ring-foreground/5";

export function HistoryImportBanner(props: { migration: EngineV2MigrationStatus | null }) {
  const { migration } = props;
  const count = migration && migration.phase === "copying" && migration.total > 0
    ? t("engine_migration.progress_copied", { done: formatCount(handledCount(migration)), total: formatCount(migration.total) })
    : null;
  return (
    <MigrationFloatingRegion>
      <div role="status" aria-live="polite" data-testid="engine-migration-banner" className={noticeClassName}>
        <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("engine_migration.copying_title")}</p>
          <p className="text-xs text-muted-foreground">{count ? `${count}. ` : ""}{t("engine_migration.copying_note")}</p>
        </div>
      </div>
    </MigrationFloatingRegion>
  );
}

export function HistoryImportErrorNotice(props: {
  retrying: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <MigrationFloatingRegion>
      <div role="alert" data-testid="engine-migration-error" className={noticeClassName}>
        <TriangleAlert className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("engine_migration.copy_error_title")}</p>
          <p className="text-xs text-muted-foreground">{t("engine_migration.copy_error_note")}</p>
        </div>
        <Button type="button" size="xs" variant="ghost" disabled={props.retrying} onClick={props.onDismiss}>
          {t("common.close")}
        </Button>
        <Button type="button" size="xs" variant="outline" disabled={props.retrying} onClick={props.onRetry}>
          {t("engine_migration.try_again")}
        </Button>
      </div>
    </MigrationFloatingRegion>
  );
}

const COPYING_POLL_MS = 1_000;
const IDLE_POLL_MS = 30_000;
const STARTUP_RETRY_MS = 2_000;

async function resolveHistoryImportClient(): Promise<HistoryImportClient | null> {
  const connection = await resolveOpenworkConnection();
  if (!connection.normalizedBaseUrl || !connection.resolvedToken) return null;
  return createOpenworkServerClient({
    baseUrl: connection.normalizedBaseUrl,
    token: connection.resolvedToken,
    hostToken: connection.resolvedHostToken,
  });
}

/**
 * Polls the host's import status: every second while copying, otherwise
 * rarely (a restarted server may start copying again). The end of a copy
 * dispatches {@link CHAT_HISTORY_IMPORTED_EVENT}.
 */
export function useHistoryImportObserver(options: {
  enabled: boolean;
  resolveClient?: () => Promise<HistoryImportClient | null>;
}) {
  const { enabled } = options;
  const resolveClient = options.resolveClient ?? resolveHistoryImportClient;
  const resolveClientRef = useRef(resolveClient);
  resolveClientRef.current = resolveClient;
  const [view, setView] = useState<HistoryImportView>({ kind: "idle" });
  const clientRef = useRef<HistoryImportClient | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [pollNow, setPollNow] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: number | undefined;
    let wasCopying = false;
    const poll = async () => {
      let next: HistoryImportView | null = null;
      try {
        const client = await resolveClientRef.current();
        if (cancelled) return;
        clientRef.current = client;
        if (client) next = historyImportView(await client.getEngineV2PreviewStatus());
      } catch {
        // The local server may be starting or restarting; try again shortly.
      }
      if (cancelled) return;
      if (next) {
        if (wasCopying && next.kind !== "copying") window.dispatchEvent(new CustomEvent(CHAT_HISTORY_IMPORTED_EVENT));
        wasCopying = next.kind === "copying";
        setView(next);
      }
      const delay = !next ? STARTUP_RETRY_MS : next.kind === "copying" ? COPYING_POLL_MS : IDLE_POLL_MS;
      timer = window.setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, pollNow]);

  const retry = async () => {
    const client = clientRef.current;
    if (!client || retrying) return;
    setRetrying(true);
    try {
      setView(historyImportView(await client.migrateOpencodeHistory()));
    } catch {
      // The notice stays; the next status read reports the current state.
    } finally {
      setRetrying(false);
      setPollNow((value) => value + 1);
    }
  };

  const errorKey = view.kind === "error" ? `${view.migration.startedAt ?? ""}:${view.migration.error ?? ""}` : null;
  return {
    view,
    retrying,
    showError: view.kind === "error" && errorKey !== dismissedError,
    retry,
    dismissError: () => setDismissedError(errorKey),
  };
}

export function EngineMigrationOverlay(props: {
  discoverRunningMigration?: boolean;
  resolveClient?: () => Promise<HistoryImportClient | null>;
}) {
  const desktop = isDesktopRuntime();
  const observer = useHistoryImportObserver({
    enabled: desktop && props.discoverRunningMigration !== false,
    resolveClient: props.resolveClient,
  });
  if (!desktop) return null;
  const { view } = observer;
  if (view.kind === "copying") return <HistoryImportBanner migration={view.migration} />;
  if (view.kind === "error" && observer.showError) {
    return (
      <HistoryImportErrorNotice
        retrying={observer.retrying}
        onRetry={() => void observer.retry()}
        onDismiss={observer.dismissError}
      />
    );
  }
  return null;
}
