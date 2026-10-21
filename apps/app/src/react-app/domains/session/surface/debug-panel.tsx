/** @jsxImportSource react */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, Copy, Bug, GripHorizontal, RefreshCw, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDebugRailSlot } from "../panel/debug-rail-slot";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { appBuildInfo } from "@/app/lib/desktop";
import { createClient, unwrap } from "@/app/lib/opencode";
import { createClientV2, isOpencodeV2BaseUrl } from "@/app/lib/opencode-v2-adapter";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { toast } from "@/components/ui/sonner";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { useWorkspaceSyncStreamStore, workspaceSyncStreamKey } from "../sync/session-sync";
import type { SessionRenderModel } from "../sync/transition-controller";

type PanelBounds = { left: number; top: number; width: number; height: number };

function DiagnosticTable({ rows }: { rows: readonly (readonly [string, string | number])[] }) {
  return (
    <table className="w-full table-fixed text-xs">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label} className="border-b border-dls-border/50 last:border-0">
            <th scope="row" className="w-28 py-1.5 pr-3 text-left align-top font-normal text-dls-secondary">{label}</th>
            <td className="break-all py-1.5 text-right font-mono text-dls-text">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SessionDebugPanel(props: {
  model: SessionRenderModel;
  client: OpenworkServerClient;
  workspaceId: string;
  opencodeBaseUrl: string;
  openworkToken: string;
  status: string;
  messageCount: number;
  todoCount: number;
  modelLabel: string;
  waitingOn: string;
}) {
  const [dismissed, setDismissed] = useState(true);
  const slot = useDebugRailSlot();
  const panelRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [bounds, setBounds] = useState<PanelBounds>({ left: 0, top: 0, width: 380, height: 352 });
  const interaction = useRef<{ kind: "move" | "resize"; x: number; y: number; bounds: PanelBounds; rect: DOMRect } | null>(null);
  const streamKey = workspaceSyncStreamKey({ workspaceId: props.workspaceId, baseUrl: props.opencodeBaseUrl });
  const streamPhase = useWorkspaceSyncStreamStore(state => state.phasesByKey[streamKey]);
  const reconcileHealth = useWorkspaceSyncStreamStore(state => state.reconcileHealthByKey[streamKey]);

  const diagnostics = useQuery({
    queryKey: ["react-session-debug-health", props.client.baseUrl, props.workspaceId, props.opencodeBaseUrl],
    enabled: !dismissed,
    retry: false,
    refetchInterval: dismissed ? false : 15_000,
    queryFn: async ({ signal }) => {
      const engine = isOpencodeV2BaseUrl(props.opencodeBaseUrl)
        ? createClientV2(props.opencodeBaseUrl, undefined, { token: props.openworkToken })
        : createClient(props.opencodeBaseUrl, undefined, { mode: "openwork", token: props.openworkToken });
      const started = performance.now();
      const [server, opencode] = await Promise.allSettled([
        props.client.health(),
        engine.global.health({ signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) }).then(unwrap),
      ]);
      return {
        server: server.status === "fulfilled" ? server.value : null,
        opencode: opencode.status === "fulfilled" ? opencode.value : null,
        // Includes authenticated workspace proxy and parsing; not inference latency.
        latencyMs: Math.round(performance.now() - started),
        checkedAt: new Date().toLocaleTimeString(),
      };
    },
  });
  const build = useQuery({
    queryKey: ["react-session-debug-build"],
    queryFn: () => appBuildInfo(),
    enabled: !dismissed && isDesktopRuntime(),
    staleTime: Infinity,
    retry: false,
  });

  useEffect(() => {
    const fit = () => setBounds({ left: 0, top: 0, width: Math.min(380, window.innerWidth), height: Math.min(352, window.innerHeight) });
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const data = diagnostics.data;
  const connected = data?.server?.ok === true && data?.opencode?.healthy === true;
  const connectionLabel = diagnostics.isFetching ? "Checking" : !data ? "Not checked" : connected ? "Connected" : "Health check failed";
  const latency = connected && !diagnostics.isFetching ? `${data.latencyMs} ms` : "—";
  const version = build.data?.version ?? import.meta.env.VITE_OPENWORK_APP_VERSION ?? "Unknown";
  const rows = [
    ["Status", props.status],
    ["Waiting on", props.waitingOn],
    ["Messages / todos", `${props.messageCount} / ${props.todoCount}`],
    ["Model", props.modelLabel || "Unknown"],
    [isDesktopRuntime() ? "Desktop" : "Web app", version],
    ["OpenCode", data?.opencode?.version ?? "Unavailable"],
  ] as const;
  const details = [
    ["Intended session", props.model.intendedSessionId || "—"],
    ["Rendered session", props.model.renderedSessionId || "—"],
    ["Transition", props.model.transitionState],
    ["Render source", props.model.renderSource],
    ["Workspace", props.workspaceId],
    ["OpenWork server", data?.server?.version ?? "Unavailable"],
    ["Build", build.data?.gitSha ?? import.meta.env.VITE_OPENWORK_BUILD_SHA ?? "Unknown"],
    ["Sync failures", reconcileHealth?.consecutiveFailures ?? 0],
    ["Last checked", data?.checkedAt ?? "—"],
  ] as const;

  function startInteraction(event: PointerEvent<HTMLButtonElement>, kind: "move" | "resize") {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = panelRef.current?.getBoundingClientRect();
    if (rect) interaction.current = { kind, x: event.clientX, y: event.clientY, bounds, rect };
  }
  function movePointer(event: PointerEvent<HTMLButtonElement>) {
    const start = interaction.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    setBounds(adjustBounds(start.bounds, start.rect, dx, dy, start.kind));
  }
  function adjustBounds(previous: PanelBounds, rect: Pick<DOMRect, "left" | "top" | "right" | "bottom">, dx: number, dy: number, kind: "move" | "resize"): PanelBounds {
    if (kind === "move") {
      return {
        ...previous,
        left: previous.left + Math.max(-rect.left, Math.min(dx, window.innerWidth - rect.right)),
        top: previous.top + Math.max(-rect.top, Math.min(dy, window.innerHeight - rect.bottom)),
      };
    }
    const width = Math.max(Math.min(300, window.innerWidth), Math.min(previous.width + dx, window.innerWidth - rect.left));
    const height = Math.max(Math.min(240, window.innerHeight), Math.min(previous.height + dy, window.innerHeight - rect.top));
    // Base UI anchors the bottom-right corner. Offset size changes so resizing
    // keeps the moved panel's top-left corner in place.
    return { ...previous, width, height,
      left: previous.left + width - previous.width,
      top: previous.top + height - previous.height };
  }
  function adjustWithKeyboard(event: KeyboardEvent<HTMLButtonElement>, kind: "move" | "resize") {
    const dx = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const dy = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    const rect = panelRef.current?.getBoundingClientRect();
    const amount = event.shiftKey ? 40 : 10;
    if (!rect) return;
    // Key presses can arrive before React commits the previous one. Accumulate
    // from pending state and account for its geometry relative to this render.
    setBounds(previous => adjustBounds(previous, {
      left: rect.left + previous.left - bounds.left - (previous.width - bounds.width),
      top: rect.top + previous.top - bounds.top - (previous.height - bounds.height),
      right: rect.right + previous.left - bounds.left,
      bottom: rect.bottom + previous.top - bounds.top,
    }, dx * amount, dy * amount, kind));
  }
  async function copyDiagnostics() {
    try {
      // Omit URLs, credentials, workspace paths and conversation content.
      await navigator.clipboard.writeText([
        "React session debug", ...rows, ...details,
        ["Connection", connectionLabel], ["Health round trip", latency], ["Event stream", streamPhase ?? "Not started"],
      ].map(row => typeof row === "string" ? row : `${row[0]}: ${row[1]}`).join("\n"));
      setCopied(true);
    } catch {
      toast.error("Could not copy diagnostics. Try again.");
    }
  }

  if (!slot) return null;

  return createPortal(
    <Popover open={!dismissed} onOpenChange={open => {
      setDismissed(!open);
      if (open) setBounds({ left: 0, top: 0, width: Math.min(380, window.innerWidth), height: Math.min(352, window.innerHeight) });
    }}>
      <PopoverTrigger render={<Button variant="ghost" size="icon-sm" className="rounded-xl" aria-label="Show session debug" title="Show session debug" />}>
        <Bug className="size-4" />
      </PopoverTrigger>
      <PopoverContent ref={panelRef} aria-label="React session debug" data-testid="session-debug-panel"
        // Overlap the trigger so the footer bug occupies its exact position.
        side="top" align="end" alignOffset={-4} sideOffset={-40} collisionPadding={0}
        style={{ width: bounds.width, height: bounds.height, translate: `${bounds.left}px ${bounds.top}px` }}
        className="gap-0 overflow-hidden rounded-2xl bg-dls-surface p-0 text-xs text-dls-secondary shadow-[var(--dls-card-shadow)] ring-0 transition-none data-open:animate-none data-closed:animate-none"
      >
      <header className="flex shrink-0 items-center gap-1 border-b border-dls-border px-3 py-2">
        <Button variant="ghost" size="sm" className="min-w-0 flex-1 touch-none select-none justify-start gap-2 px-0 text-xs font-medium text-dls-text cursor-grab active:cursor-grabbing"
          aria-label="Move session debug" title="Drag to move; arrow keys to nudge"
          onPointerDown={event => startInteraction(event, "move")} onPointerMove={movePointer}
          onPointerUp={() => { interaction.current = null; }} onPointerCancel={() => { interaction.current = null; }}
          onLostPointerCapture={() => { interaction.current = null; }} onKeyDown={event => adjustWithKeyboard(event, "move")}
        >
          <GripHorizontal className="size-4 shrink-0 text-dls-secondary" /><span className="truncate">React session debug</span>
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={copied ? "Diagnostics copied" : "Copy diagnostics"} title="Copy diagnostics" onClick={() => void copyDiagnostics()}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss session debug" title="Dismiss" onClick={() => setDismissed(true)}><X className="size-4" /></Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-1">
        <DiagnosticTable rows={rows} />
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="group w-full justify-start gap-1 px-0 text-xs" />}>
            <ChevronRight className="size-3 transition-transform group-data-panel-open:rotate-90" /> More details
          </CollapsibleTrigger>
          <CollapsibleContent><DiagnosticTable rows={details} /></CollapsibleContent>
        </Collapsible>
      </div>
      <footer className="shrink-0 border-t border-dls-border px-1 py-2 text-[11px]">
        <div className="flex items-center gap-2 px-2">
          <span className={data && !connected ? "text-destructive" : "text-dls-text"}>{connectionLabel}</span>
          <span className="ml-auto tabular-nums" title="Combined server and engine health round trip, including proxy overhead">Health RTT {latency}</span>
          <Button variant="ghost" size="icon-sm" aria-label="Refresh diagnostics" title="Refresh diagnostics" disabled={diagnostics.isFetching} onClick={() => void diagnostics.refetch()}><RefreshCw className="size-3" /></Button>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="pl-2">Event stream: {streamPhase ?? "Not started"}</span>
          <Button variant="ghost" size="icon-sm" className="ml-auto touch-none cursor-se-resize" aria-label="Resize session debug" title="Drag to resize; arrow keys to resize"
            onPointerDown={event => startInteraction(event, "resize")} onPointerMove={movePointer}
            onPointerUp={() => { interaction.current = null; }} onPointerCancel={() => { interaction.current = null; }}
            onLostPointerCapture={() => { interaction.current = null; }} onKeyDown={event => adjustWithKeyboard(event, "resize")}
          ><GripHorizontal className="size-3" /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Hide session debug" title="Hide session debug" onClick={() => setDismissed(true)}><Bug className="size-4" /></Button>
        </div>
      </footer>
      </PopoverContent>
    </Popover>, slot,
  );
}
