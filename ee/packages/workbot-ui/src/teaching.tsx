"use client";

import { Button } from "@base-ui/react/button";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { compileBrowserDemonstration, demonstrationReplySchema, type BrowserDemonstration, type DemonstrationCommand } from "@openwork/types/browser-demonstration";
import { skillCreatedPayloadSchema, type SkillCreatedPayload } from "@openwork/types/skill-created-app";
import { errorMessage, workbotHost } from "./host";

const button = "inline-flex h-8 items-center justify-center rounded-lg px-3 text-[13px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-chip)] disabled:opacity-50 focus-visible:shadow-[var(--wb-focus)]";
const input = "w-full rounded-lg border border-[var(--wb-hairline)] bg-[var(--wb-surface)] px-3 py-2 text-[13px] text-[var(--wb-text)] focus-visible:shadow-[var(--wb-focus)]";
const saveSchema = z.object({ saved: skillCreatedPayloadSchema, markdown: z.string() });

/** The same production panel is used beside the live browser and in its UI journey. */
export function WorkbotTeaching({ onTakeControl, onTeachingChange, onRun }: { onTakeControl(): void; onTeachingChange?(id: string | undefined): void; onRun?(text: string): void }) {
  const host = workbotHost();
  const [demo, setDemo] = useState<BrowserDemonstration | null>(null);
  const [tabs, setTabs] = useState<Array<{ id: string; origin: string }>>([]);
  const [tab, setTab] = useState("");
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [saved, setSaved] = useState<SkillCreatedPayload | null>(null);
  const [runInputs, setRunInputs] = useState("");
  const [stepId, setStepId] = useState<number | null>(null);
  const [explanation, setExplanation] = useState("");
  const [variable, setVariable] = useState("");
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const changes = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onTeachingChange?.(undefined); }; }, [onTeachingChange]);
  const accept = useCallback((payload: unknown) => {
    const reply = demonstrationReplySchema.parse(payload);
    setDemo(reply.demonstration);
    if (reply.tabs) { setTabs(reply.tabs); setTab(current => reply.tabs?.some(tab => tab.id === current) ? current : reply.tabs?.[0]?.id ?? ""); }
    onTeachingChange?.(reply.demonstration?.phase === "recording" ? reply.demonstration.id : undefined);
  }, [onTeachingChange]);
  const command = async (body: DemonstrationCommand) => {
    if (inFlight.current) return;
    inFlight.current = true; changes.current++; setBusy(true); setError(null);
    try {
      const { response, payload } = await host.requestJson("/v1/workbot/teaching", { method: "POST", body: JSON.stringify(body) }, 195_000);
      if (!response.ok) throw new Error(errorMessage(payload, "Couldn't update the demonstration. Reconnect to check its state."));
      if (!mounted.current) return;
      accept(payload);
      if (body.action === "start" || body.action === "resume") onTakeControl();
      if (body.action === "discard") { setSaved(null); setStepId(null); }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : "Teaching is unavailable."); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  useEffect(() => {
    if ((!opened && !demo) || !host.browserDemonstrations || host.documentAuthorization) { onTeachingChange?.(undefined); return; }
    let disposed = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!inFlight.current) {
        const revision = changes.current;
        try {
          const { response, payload } = await host.requestJson("/v1/workbot/teaching", { method: "POST", body: JSON.stringify({ action: "read" }), signal: controller.signal }, 30_000);
          if (!disposed && revision === changes.current && response.ok) { accept(payload); setError(null); }
          else if (!disposed && revision === changes.current) { onTeachingChange?.(undefined); setError(errorMessage(payload, "Teaching access couldn't be verified. Recording will pause.")); }
        } catch { if (!disposed) { onTeachingChange?.(undefined); setError("Teaching disconnected. Recording will pause; reconnect before continuing."); } }

      }
      if (!disposed) timer = setTimeout(() => void poll(), 3000);
    };
    timer = setTimeout(() => void poll(), 3000);
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [opened, host, accept, onTeachingChange, demo?.id]);
  const save = async () => {
    if (!demo || inFlight.current) return;
    inFlight.current = true; changes.current++; setBusy(true); setError(null);
    try {
      const { response, payload } = await host.requestJson("/v1/workbot/teaching", { method: "POST", body: JSON.stringify({ action: "save", demonstrationId: demo.id, name, purpose }) }, 60_000);
      if (!response.ok) throw new Error(errorMessage(payload, "Couldn't confirm the save. Check your skill library before trying again."));
      if (mounted.current) setSaved(saveSchema.parse(payload).saved);
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : "Couldn't confirm the save."); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const selected = demo?.steps.find(step => step.id === stepId);
  let preview = "";
  if (demo?.phase === "draft" && name.trim() && purpose.trim()) { try { preview = compileBrowserDemonstration(demo, name, purpose); } catch { /* An incomplete draft stays editable. */ } }
  const enabled = host.browserDemonstrations === true && !host.documentAuthorization;
  return <section aria-label="Teach Workbot" className="flex min-h-0 w-full flex-col border-b border-[var(--wb-hairline)] bg-[var(--wb-bg)] text-[var(--wb-text)]" data-testid="workbot-teaching">
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
      <Button className={button} disabled={!enabled || busy} onClick={() => { setOpened(current => !current); if (!opened) void command({ action: "tabs" }); }} aria-expanded={opened}>{enabled ? "Teach Workbot" : "Teaching is off · Ask your admin"}</Button>
      {(opened || demo) && <span role="status" className="text-[12px] text-[var(--wb-muted)]">{saved ? "Saved · Not yet tested" : demo ? `${demo.phase === "recording" ? "Recording" : demo.phase === "paused" ? "Paused" : "Draft"} · ${demo.steps.length} steps` : "No demonstration"}</span>}
    </div>
    {opened && <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto px-4 pb-4">
      {error && <p role="alert" className="text-[13px]">{error}</p>}
      {demo?.notice && <p role="status" className="text-[13px]">{demo.notice}</p>}
      {!demo ? <>
        <label className="text-[13px]">Browser tab<select aria-label="Tab to teach" className={input} value={tab} disabled={busy} onChange={event => setTab(event.target.value)}>{tabs.map((tab, index) => <option key={tab.id} value={tab.id}>{tab.origin === "null" ? "Blank page" : tab.origin} · Tab {index + 1}</option>)}</select></label>
        <div className="flex gap-2"><Button className={button} disabled={!enabled || busy || !tab} onClick={() => void command({ action: "start", tabId: tab })}>Start teaching</Button><Button className={button} disabled={!enabled || busy} onClick={() => void command({ action: "tabs" })}>Refresh tabs</Button></div>
      </> : <>
        {demo.phase !== "draft" && <div className="flex flex-wrap gap-1">
          <Button className={button} disabled={!enabled || busy} onClick={() => void command({ action: demo.phase === "recording" ? "pause" : "resume" })}>{demo.phase === "recording" ? "Pause recording" : "Resume recording"}</Button>
          <Button className={button} disabled={!enabled || busy || demo.phase !== "recording"} onClick={() => void command({ action: "pick" })}>Select information</Button>
          <Button className={button} disabled={!enabled || busy || !demo.steps.length} onClick={() => void command({ action: "finish" })}>Finish teaching</Button>
        </div>}
        <ol className="space-y-1" aria-label="Demonstrated steps">{demo.steps.map(step => <li key={step.id}><Button className={`${button} h-auto min-h-8 w-full justify-start text-left ${stepId === step.id ? "bg-[var(--wb-chip)]" : ""}`} onClick={() => { setStepId(step.id); setExplanation(step.explanation); setVariable(step.parameter ?? step.field ?? ""); }}>{step.id}. {step.kind === "navigate" ? `Open ${step.url}` : `${step.kind === "extract" ? "Collect" : step.kind} ${step.target?.name || step.target?.role || "information"}`}{step.parameter ? ` · ${step.parameter}` : step.field ? ` · ${step.field}` : ""}</Button></li>)}</ol>
        {selected && !saved && <div className="flex flex-col gap-2">
          <label className="text-[13px]">Explain step {selected.id}<textarea className={input} value={explanation} maxLength={2000} onChange={event => setExplanation(event.target.value)} /></label>
          {(selected.parameter || selected.field) && <label className="text-[13px]">{selected.parameter ? "Input name" : "Output field"}<input className={input} value={variable} onChange={event => setVariable(event.target.value)} pattern="[a-z][a-z0-9_]{0,63}" /></label>}
          <Button className={button} disabled={!enabled || busy || Boolean((selected.parameter || selected.field) && !/^[a-z][a-z0-9_]{0,63}$/.test(variable))} onClick={() => void command({ action: "edit", stepId: selected.id, explanation, ...(selected.parameter ? { parameter: variable } : selected.field ? { field: variable } : {}) })}>Save step</Button>
        </div>}
        {demo.phase === "draft" && !saved && <>
          <label className="text-[13px]">Skill name<input className={input} value={name} maxLength={100} onChange={event => setName(event.target.value)} /></label>
          <label className="text-[13px]">When to use this skill<textarea className={input} value={purpose} maxLength={1000} onChange={event => setPurpose(event.target.value)} /></label>
          {preview && <details><summary className="cursor-pointer text-[13px]">Skill instructions</summary><pre className="mt-2 whitespace-pre-wrap break-words text-[12px]">{preview}</pre></details>}
          <Button className={`${button} bg-[var(--wb-chip)]`} disabled={!enabled || busy || !preview} onClick={() => void save()}>Save private skill</Button>
        </>}
        {saved && <>
          <p role="status" className="text-[13px]">Saved “{saved.name}” to your private skills.</p>
          {saved.libraryUrl && /^https?:\/\//.test(saved.libraryUrl) && <a className="text-[13px] underline" href={saved.libraryUrl} target="_blank" rel="noopener noreferrer">Open saved skill</a>}
          <label className="text-[13px]">Inputs for a new run<textarea className={input} value={runInputs} onChange={event => setRunInputs(event.target.value)} placeholder="Provide new values, or ask Workbot to collect them." /></label>
          <Button className={button} disabled={!enabled || !onRun || busy} onClick={() => onRun?.(`Use my saved browser skill ${JSON.stringify(saved.name)} with these inputs: ${JSON.stringify(runInputs)}. Read the saved instructions, ask for missing inputs, and verify the requested outputs.`)}>Run skill</Button>
        </>}
        <Button className={button} disabled={!enabled || busy} onClick={() => void command({ action: "discard" })}>{saved ? "Teach another task" : "Discard demonstration"}</Button>
      </>}
    </div>}
  </section>;
}
