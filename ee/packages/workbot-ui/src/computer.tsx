/// <reference path="./novnc.d.ts" />
"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { ExternalLink, Globe, Maximize2, Monitor, Pause, Play, RotateCw, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { BrowserTeachingContext } from "@openwork/types/browser-demonstration";
import { WorkbotTeaching } from "./teaching";
import { ScreencastViewer, type ScreencastPage } from "./screencast";
import { errorMessage, workbotHost } from "./host";
import type { WorkbotPage } from "./data";

const viewerSchema = z.union([z.object({ state: z.literal("paused") }), z.object({ state: z.literal("connected"), url: z.string().url(), expiresAt: z.number(), paused: z.boolean() })]);
const button = "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-chip)] disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";

type ComputerView = "browser" | "computer";

/** Each view has its own path (/browser, /computer), so a reload or a shared link opens the same view. */
function viewFromLocation(): ComputerView {
  return typeof window !== "undefined" && window.location.pathname.replace(/\/+$/, "") === "/computer" ? "computer" : "browser";
}

/** A page Workbot opened has its own link, /browser/<id>: the Browser view with that page picked out. */
function pageFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return /^\/browser\/([a-z0-9]{1,16})\/?$/.exec(window.location.pathname)?.[1] ?? null;
}

/** Opens a page Workbot opened, in its Browser view, without reloading Workbot. */
export function openBrowserPage(id: string) {
  window.history.pushState(null, "", `/browser/${id}${window.location.search}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Both views belong to the main conversation's computer. noVNC carries pixels and native input; with the browser live
 * view on, watching the browser streams the page itself instead.
 */
export function WorkbotComputer({ onTeachingChange, onRun, canTeach = true, pages = [] }: { onTeachingChange?(context: BrowserTeachingContext | undefined): void; onRun?(text: string): void | Promise<void>; canTeach?: boolean; /** The pages Workbot opened in this conversation, oldest first. */ pages?: WorkbotPage[] }) {
  const host = workbotHost();
  const [teaching, setTeaching] = useState<BrowserTeachingContext>();
  const teachingChange = useCallback((context: BrowserTeachingContext | undefined) => { setTeaching(context); onTeachingChange?.(context); }, [onTeachingChange]);
  const recording = teaching !== undefined && teaching.phase !== "draft";
  const screen = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [view, setViewState] = useState<ComputerView>(viewFromLocation);
  const [page, setPage] = useState(pageFromLocation);
  const setView = (next: ComputerView) => {
    if (next === view) return;
    window.history.pushState(null, "", `/${next}${window.location.search}`);
    setViewState(next); setPage(null);
  };
  useEffect(() => {
    const sync = () => { if (/^\/(browser(\/[a-z0-9]{1,16})?|computer)\/?$/.test(window.location.pathname)) { setViewState(viewFromLocation()); setPage(pageFromLocation()); } };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const [control, setControl] = useState(false);
  const [agentPaused, setAgentPaused] = useState(false);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [changing, setChanging] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [livePage, setLivePage] = useState<ScreencastPage | null>(null);
  const identity = host.identity ? `${host.identity.organizationId}:${host.identity.principalId}` : "";
  const away = useAway(30_000) && !recording;

  useEffect(() => {
    const target = screen.current;
    // Nobody watching a hidden tab, so stop streaming until it is shown again.
    if (!target || paused || away) return;
    setError(null); setConnected(false); setReconnecting(false); setLivePage(null);
    return connectDesktopViewer(target, host, { view, control, wake: true, screencast: host.browserLiveView === true }, {
      paused: () => setPaused(true),
      agentPaused: setAgentPaused,
      connected: () => { setConnected(true); setReconnecting(false); setError(null); },
      reconnecting: () => { setConnected(false); setReconnecting(true); },
      failed: (message) => { setConnected(false); setError(message); },
      page: setLivePage,
    });
  }, [host, identity, view, control, paused, away, revision]);

  const action = async (next: "pause" | "resume" | "continue" | "rebuild") => {
    if (changing) return false;
    setChanging(true); setError(null); setRebuilding(next === "rebuild");
    try {
      const { response, payload } = await host.requestJson("/v1/workbot/computer/action", { method: "POST", body: JSON.stringify({ action: next }) }, 195_000);
      if (!response.ok) throw new Error(errorMessage(payload, "Your computer didn't respond. Try again."));
      if (next === "continue" || next === "rebuild") { setControl(false); setAgentPaused(false); }
      setPaused(next === "pause");
      setRevision(current => current + 1);
      return true;
    } catch (error) { setError(error instanceof Error ? error.message : "Your computer didn't respond."); }
    finally { setChanging(false); setRebuilding(false); }
  };

  return <section ref={container} className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Computer">
    <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--wb-hairline)] px-3 py-2 sm:px-6">
      <div className="flex items-center gap-1" role="group" aria-label="Computer view">
        {(["browser", "computer"] as const).map(value => <button key={value} type="button" aria-pressed={view === value} disabled={recording} onClick={() => setView(value)} className={`${button} ${view === value ? "bg-[var(--wb-chip)]" : ""}`}>{value === "browser" ? "Browser" : "Computer"}</button>)}
      </div>
      <div className="flex items-center gap-1">
        <span className="mr-2 hidden text-[12px] text-[var(--wb-muted)] sm:inline" role="status">{paused ? "Paused" : error ? "Disconnected" : connected ? control ? "You have control" : "Live" : "Connecting…"}</span>
        {paused ? <button type="button" className={button} disabled={changing} onClick={() => void action("resume")}><Play size={14} aria-hidden />Resume</button> : <>
          <button type="button" className={button} disabled={changing || !connected || recording} onClick={() => control ? void action("continue") : setControl(true)}>{control ? "Return to Workbot" : "Take control"}</button>
          {agentPaused && !control ? <button type="button" className={button} disabled={changing} onClick={() => void action("continue")}>Continue Workbot</button> : null}
          <button type="button" className={button} disabled={changing} onClick={() => void action("pause")}><Pause size={14} aria-hidden />Pause</button>
        </>}
        <button type="button" className={button} aria-label="Full screen" onClick={() => void container.current?.requestFullscreen().catch(() => setError("Full screen isn't available in this browser."))}><Maximize2 size={14} aria-hidden /></button>
      </div>
    </div>
    {view === "browser" && pages.length > 0 ? <BrowserPages pages={pages} selected={page} /> : null}
    {view === "browser" && livePage && !paused && !error ? <LiveAddress page={livePage} /> : null}
    {canTeach && host.browserDemonstrations === true && <div hidden={view !== "browser"} style={{ display: view === "browser" ? undefined : "none" }}><WorkbotTeaching suspended={paused} onTeachingChange={teachingChange} onTakeControl={() => setControl(true)} onRun={onRun ? async text => { if (!await action("continue")) throw new Error("Return browser control to Workbot before starting the run. Your inputs are still here."); await onRun(text); } : undefined} /></div>}
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#f5f6f7]">
      <div ref={screen} className={`relative h-full w-full ${paused || error ? "hidden" : ""}`} aria-label={`${view === "browser" ? "Browser" : "Computer"} live view`} />
      {!paused && !error && !connected ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <ComputerLoading />
        <span className="workbot-shimmer text-[13px]">{rebuilding ? "Rebuilding your computer" : reconnecting ? "Reconnecting" : view === "browser" ? "Connecting to the browser" : "Connecting to your computer"}</span>
      </div> : null}
      {paused || error ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <Monitor size={24} strokeWidth={1.5} className="text-[var(--wb-muted)]" aria-hidden />
        <p className="text-[14px] text-[var(--wb-text)]">{error ?? "Your computer is paused."}</p>
        <div className="flex flex-wrap items-center justify-center gap-1">
          <button type="button" className={button} disabled={changing} onClick={() => paused ? void action("resume") : setRevision(current => current + 1)}>{paused ? <Play size={14} aria-hidden /> : <RotateCw size={14} aria-hidden />}{paused ? "Resume" : "Reconnect"}</button>
          {paused ? null : <RebuildComputer disabled={changing} onRebuild={() => void action("rebuild")} />}
        </div>
      </div> : null}
    </div>
  </section>;
}

type ViewerEvents = {
  paused(): void;
  agentPaused(paused: boolean): void;
  connected(): void;
  reconnecting(): void;
  failed(message: string): void;
  /** The address and title of the tab the screencast shows. noVNC shows the browser's own toolbar instead. */
  page?(page: ScreencastPage): void;
};

/**
 * Streams one view of the member's computer into `target`, renewing the connection before the computer closes it and
 * reconnecting a few times when it drops. Returns the function that closes it. With `screencast`, watching the browser
 * uses the computer's page stream; a computer whose image predates it refuses the stream, and the view falls back to
 * noVNC. With `wake`, a paused computer is resumed instead of reported as paused.
 */
export function connectDesktopViewer(target: HTMLElement, host: ReturnType<typeof workbotHost>, options: { view: ComputerView; control: boolean; wake?: boolean; screencast?: boolean }, events: ViewerEvents) {
  const { view, control } = options;
  let disposed = false;
  let screencastRefused = false;
  // The live connection, and its replacement while it connects.
  let client: import("@novnc/novnc").default | ScreencastViewer | null = null;
  let next: import("@novnc/novnc").default | ScreencastViewer | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let renewal: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let failures = 0;
  /** `renewing` keeps the current picture on screen until the replacement connects. */
  const connect = async (renewing = false) => {
    if (disposed) return;
    const request = new AbortController();
    const abort = () => request.abort();
    controller.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 195_000);
    try {
      const { response, payload } = await host.requestJson("/v1/workbot/computer/viewer", {
        method: "POST", body: JSON.stringify({ view, control, ...(options.wake ? { wake: true } : {}) }), signal: request.signal,
      }, 195_000);
      if (disposed) return;
      if (!response.ok) {
        // A failed early renewal is retried when the live connection closes.
        if (renewing && client) return;
        events.failed(errorMessage(payload, response.status === 403 ? "Computer access is off for your organization." : "Your computer is unavailable. Try reconnecting."));
        return;
      }
      const session = viewerSchema.parse(payload);
      if (session.state === "paused") { events.paused(); return; }
      events.agentPaused(session.paused);
      // The computer issues one ticket for watching the browser; its page stream and VNC accept it at sibling paths.
      const streamUrl = options.screencast && view === "browser" && !control && !screencastRefused && /\/vnc\/[A-Za-z0-9_-]{43}$/.test(session.url)
        ? session.url.replace(/\/vnc\/([A-Za-z0-9_-]{43})$/, "/screencast/$1") : null;
      const RFB = streamUrl ? null : (await import("@novnc/novnc")).default;
      if (disposed) return;
      // Each connection draws into its own layer, shown once it is live.
      const layer = document.createElement("div");
      layer.style.cssText = "position:absolute;inset:0;visibility:hidden";
      target.append(layer);
      let candidate: import("@novnc/novnc").default | ScreencastViewer;
      if (RFB) {
        const rfb = new RFB(layer, session.url, { shared: true });
        rfb.viewOnly = !control;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.background = "#f5f6f7";
        // Stronger zlib for the non-photo parts of the screen (noVNC defaults to 2) to save bandwidth.
        rfb.compressionLevel = 6;
        candidate = rfb;
      } else {
        const stream = new ScreencastViewer(layer, streamUrl!);
        stream.addEventListener("page", (event) => { if (!disposed && client === stream) events.page?.((event as CustomEvent<ScreencastPage>).detail); });
        candidate = stream;
      }
      const superseded = next;
      next = candidate;
      superseded?.disconnect();
      candidate.addEventListener("connect", () => {
        if (disposed || next !== candidate) { candidate.disconnect(); return; }
        // noVNC reports the connection before its first frame arrives, so keep the current
        // picture until the new one is drawn; otherwise every renewal flashes an empty screen.
        void firstFrame(layer).then(() => {
          if (disposed || next !== candidate) return;
          layer.style.visibility = "visible";
          const previous = client;
          client = candidate; next = null;
          previous?.disconnect();
          if (candidate instanceof ScreencastViewer && candidate.page) events.page?.(candidate.page);
          failures = 0; events.connected();
          // The computer closes each connection after a minute and renewal goes through
          // membership and flags again, so renew early instead of going blank.
          clearTimeout(renewal);
          renewal = setTimeout(() => void connect(true), 45_000);
        });
      });
      candidate.addEventListener("securityfailure", () => {
        if (!disposed && client === null) events.failed("Couldn't connect to your computer. Try reconnecting.");
      });
      candidate.addEventListener("disconnect", () => {
        layer.remove();
        if (next === candidate) next = null;
        // A stream that ends before its first frame means this computer has no page stream yet; use VNC from now on.
        if (candidate instanceof ScreencastViewer && !candidate.connected) screencastRefused = true;
        // Only the live connection closing (or a first attempt failing with nothing newer
        // in flight) changes the screen; replaced connections and failed renewals do not.
        const live = client === candidate || client === null && next === null && !renewing;
        if (disposed || !live) return;
        client = null;
        clearTimeout(renewal);
        events.reconnecting();
        failures++;
        if (failures > 3) { events.failed("Connection lost. Reconnect to continue."); return; }
        retry = setTimeout(() => void connect(), Math.min(500 * failures, 3_000));
      });
    } catch {
      if (!disposed && !(renewing && client)) events.failed("Couldn't connect to your computer. Try reconnecting.");
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", abort);
    }
  };
  void connect();
  return () => { disposed = true; controller.abort(); clearTimeout(retry); clearTimeout(renewal); next?.disconnect(); client?.disconnect(); target.replaceChildren(); };
}

/** The page stream has no browser toolbar, so show which page is on screen: its address, with the title on hover. */
function LiveAddress({ page }: { page: ScreencastPage }) {
  let address = page.url;
  try { const url = new URL(page.url); address = url.protocol === "http:" || url.protocol === "https:" ? `${url.host}${url.pathname === "/" ? "" : url.pathname}` : page.url; } catch {}
  return <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--wb-hairline)] px-3 py-1.5 text-[12px] text-[var(--wb-muted)] sm:px-6" title={page.title || page.url} aria-label="Page on screen">
    <Globe size={12} aria-hidden className="shrink-0" /><span className="truncate">{address}</span>
  </div>;
}

/**
 * The pages Workbot opened in this conversation, newest first, each with its own link (/browser/<id>). The picked one
 * also links to the site itself. The live view shows whichever tab the browser has in front.
 */
function BrowserPages({ pages, selected }: { pages: WorkbotPage[]; selected: string | null }) {
  const ordered = [...pages].reverse();
  const picked = ordered.find((entry) => entry.id === selected) ?? null;
  return <nav aria-label="Pages Workbot opened" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--wb-hairline)] px-3 py-1.5 sm:px-6">
    {ordered.map((entry) => <a key={entry.id} href={`/browser/${entry.id}${window.location.search}`} aria-current={entry.id === selected ? "page" : undefined} title={entry.url}
      onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); openBrowserPage(entry.id); }}
      className={`inline-flex h-7 max-w-[16rem] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-[var(--wb-text)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] ${entry.id === selected ? "bg-[var(--wb-chip)] font-medium" : ""}`}>
      <Globe size={12} aria-hidden className="shrink-0 text-[var(--wb-muted)]" /><span className="truncate">{entry.title}</span>
    </a>)}
    {picked ? <a href={picked.url} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">Open site<ExternalLink size={12} aria-hidden /></a> : null}
  </nav>;
}

/**
 * A small live view of what Workbot is doing on its computer, shown in the chat while it works, like the floating
 * window in OpenWork Desktop: view only, with a ring and a label saying Workbot has it. Clicking opens the full view.
 */
export function LiveGlimpse({ view, onOpen }: { view: ComputerView; onOpen?(): void }) {
  const host = workbotHost();
  const screen = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"connecting" | "live" | "unavailable">("connecting");
  const away = useAway(30_000);
  useEffect(() => {
    const target = screen.current;
    if (!target || away) return;
    setState("connecting");
    return connectDesktopViewer(target, host, { view, control: false }, {
      paused: () => setState("unavailable"),
      agentPaused: () => {},
      connected: () => setState("live"),
      reconnecting: () => setState("connecting"),
      failed: () => setState("unavailable"),
    });
  }, [host, view, away]);
  if (state === "unavailable") return null;
  const label = view === "browser" ? "Workbot is browsing" : "Workbot is using its computer";
  return <button type="button" onClick={onOpen} disabled={!onOpen} aria-label={`${label}. Open the full view`}
    className="workbot-fade-in workbot-glimpse relative mt-2 block aspect-[16/10] w-full overflow-hidden rounded-[10px] bg-[#f5f6f7] text-left outline-none focus-visible:shadow-[var(--wb-focus)] enabled:cursor-pointer">
    <div ref={screen} className="pointer-events-none absolute inset-0" aria-hidden />
    {state === "connecting" ? <span className="absolute inset-0 grid place-items-center text-[12px] text-[var(--wb-muted)]"><span className="workbot-shimmer">{view === "browser" ? "Connecting to the browser" : "Connecting to the computer"}</span></span> : null}
    <span className="absolute left-2 top-2 inline-flex items-center gap-1.5 rounded-full bg-[var(--wb-surface)]/90 px-2 py-0.5 text-[11px] font-medium text-[var(--wb-text)] shadow-[var(--wb-card-shadow)]">
      <span className="workbot-presence-dot size-1.5 rounded-full" aria-hidden />{label}
    </span>
  </button>;
}

/** Resolves once noVNC has drawn into the layer's canvas (its pixels start transparent), or after `limit` ms. */
function firstFrame(layer: HTMLElement, limit = 5_000) {
  const started = performance.now();
  return new Promise<void>(resolve => {
    const check = () => {
      const canvas = layer.querySelector("canvas");
      const alpha = canvas && canvas.width > 0 && canvas.height > 0
        ? canvas.getContext("2d")?.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data[3] ?? 0
        : 0;
      if (alpha > 0 || !layer.isConnected || performance.now() - started > limit) resolve();
      else setTimeout(check, 50);
    };
    check();
  });
}

/** True once the page has been hidden for `delay` ms, so a quick tab switch keeps the stream. */
function useAway(delay: number) {
  const [away, setAway] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") timer = setTimeout(() => setAway(true), delay);
      else setAway(false);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", sync); };
  }, [delay]);
  return away;
}

/** Replaces a computer that won't connect with a fresh one from the current image. Its disk is erased, so ask first. */
function RebuildComputer({ disabled, onRebuild }: { disabled: boolean; onRebuild(): void }) {
  const [open, setOpen] = useState(false);
  return <AlertDialog.Root open={open} onOpenChange={setOpen}>
    <AlertDialog.Trigger className={button} disabled={disabled}><Wrench size={14} aria-hidden />Rebuild computer</AlertDialog.Trigger>
    <AlertDialog.Portal>
      <AlertDialog.Backdrop className="workbot fixed inset-0 z-50 bg-[var(--wb-ink)]/20" />
      <AlertDialog.Popup className="workbot fixed left-1/2 top-1/2 z-50 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-[var(--wb-surface)] p-5 text-[var(--wb-text)] shadow-[var(--wb-panel-shadow)] outline-none">
        <AlertDialog.Title className="text-[15px] font-semibold">Rebuild your computer?</AlertDialog.Title>
        <AlertDialog.Description className="mt-2 text-[13px] text-[var(--wb-muted)]">Workbot replaces this computer with a fresh one. Its open apps, browser tabs and files are erased. Your chat and the files in Files are kept.</AlertDialog.Description>
        <div className="mt-4 flex justify-end gap-2"><AlertDialog.Close className={button}>Cancel</AlertDialog.Close><button type="button" className={button} onClick={() => { setOpen(false); onRebuild(); }}>Rebuild</button></div>
      </AlertDialog.Popup>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}

/** Workbot's computer glyph at the size of the empty screen; its lines write while the view connects (V6). */
function ComputerLoading() {
  return <svg viewBox="0 0 16 16" width={40} height={40} fill="none" className="workbot-computer is-working" aria-hidden>
    <rect x="2.25" y="3" width="11.5" height="8" rx="1.75" className="workbot-computer-screen" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    <path d="M1.5 13h13" className="workbot-computer-stand" strokeWidth={1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    <path className="workbot-computer-line" d="M4.75 6h3.5" strokeWidth={1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    <path className="workbot-computer-line" d="M4.75 8.25h5.5" strokeWidth={1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
  </svg>;
}
