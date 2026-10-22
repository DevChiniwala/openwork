/// <reference path="./novnc.d.ts" />
"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Maximize2, Monitor, Pause, Play, RotateCw, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { BrowserTeachingContext } from "@openwork/types/browser-demonstration";
import { WorkbotTeaching } from "./teaching";
import { errorMessage, workbotHost } from "./host";

const viewerSchema = z.union([z.object({ state: z.literal("paused") }), z.object({ state: z.literal("connected"), url: z.string().url(), expiresAt: z.number(), paused: z.boolean() })]);
const button = "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-chip)] disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";

type ComputerView = "browser" | "computer";

/** Each view has its own path (/browser, /computer), so a reload or a shared link opens the same view. */
function viewFromLocation(): ComputerView {
  return typeof window !== "undefined" && window.location.pathname.replace(/\/+$/, "") === "/computer" ? "computer" : "browser";
}

/** Both views belong to the main conversation's computer. noVNC carries pixels and native input. */
export function WorkbotComputer({ onTeachingChange, onRun, canTeach = true }: { onTeachingChange?(context: BrowserTeachingContext | undefined): void; onRun?(text: string): void | Promise<void>; canTeach?: boolean }) {
  const host = workbotHost();
  const [teaching, setTeaching] = useState<BrowserTeachingContext>();
  const teachingChange = useCallback((context: BrowserTeachingContext | undefined) => { setTeaching(context); onTeachingChange?.(context); }, [onTeachingChange]);
  const recording = teaching !== undefined && teaching.phase !== "draft";
  const screen = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [view, setViewState] = useState<ComputerView>(viewFromLocation);
  const setView = (next: ComputerView) => {
    if (next === view) return;
    window.history.pushState(null, "", `/${next}${window.location.search}`);
    setViewState(next);
  };
  useEffect(() => {
    const sync = () => { if (/^\/(browser|computer)\/?$/.test(window.location.pathname)) setViewState(viewFromLocation()); };
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
  const identity = host.identity ? `${host.identity.organizationId}:${host.identity.principalId}` : "";

  useEffect(() => {
    const target = screen.current;
    if (!target || paused) return;
    let disposed = false;
    // The live connection, and its replacement while it connects.
    let client: import("@novnc/novnc").default | null = null;
    let next: import("@novnc/novnc").default | null = null;
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
          method: "POST", body: JSON.stringify({ view, control }), signal: request.signal,
        }, 195_000);
        if (disposed) return;
        if (!response.ok) {
          // A failed early renewal is retried when the live connection closes.
          if (renewing && client) return;
          setConnected(false);
          setError(errorMessage(payload, response.status === 403 ? "Computer access is off for your organization." : "Your computer is unavailable. Try reconnecting."));
          return;
        }
        const session = viewerSchema.parse(payload);
        if (session.state === "paused") { setPaused(true); return; }
        setAgentPaused(session.paused);
        const { default: RFB } = await import("@novnc/novnc");
        if (disposed) return;
        // Each connection draws into its own layer, shown once it is live.
        const layer = document.createElement("div");
        layer.style.cssText = "position:absolute;inset:0;visibility:hidden";
        target.append(layer);
        const candidate = new RFB(layer, session.url, { shared: true });
        const superseded = next;
        next = candidate;
        superseded?.disconnect();
        candidate.viewOnly = !control;
        candidate.scaleViewport = true;
        candidate.resizeSession = false;
        candidate.background = "#f5f6f7";
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
            failures = 0; setConnected(true); setReconnecting(false); setError(null);
            // The computer closes each connection after a minute and renewal goes through
            // membership and flags again, so renew early instead of going blank.
            clearTimeout(renewal);
            renewal = setTimeout(() => void connect(true), 45_000);
          });
        });
        candidate.addEventListener("securityfailure", () => {
          if (!disposed && client === null) setError("Couldn't connect to your computer. Try reconnecting.");
        });
        candidate.addEventListener("disconnect", () => {
          layer.remove();
          if (next === candidate) next = null;
          // Only the live connection closing (or a first attempt failing with nothing newer
          // in flight) changes the screen; replaced connections and failed renewals do not.
          const live = client === candidate || client === null && next === null && !renewing;
          if (disposed || !live) return;
          client = null;
          clearTimeout(renewal);
          setConnected(false);
          setReconnecting(true);
          failures++;
          if (failures > 3) { setError("Connection lost. Reconnect to continue."); return; }
          retry = setTimeout(() => void connect(), Math.min(500 * failures, 3_000));
        });
      } catch {
        if (!disposed && !(renewing && client)) { setConnected(false); setError("Couldn't connect to your computer. Try reconnecting."); }
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", abort);
      }
    };
    setError(null); setConnected(false); setReconnecting(false); void connect();
    return () => { disposed = true; controller.abort(); clearTimeout(retry); clearTimeout(renewal); next?.disconnect(); client?.disconnect(); target.replaceChildren(); };
  }, [host, identity, view, control, paused, revision]);

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
