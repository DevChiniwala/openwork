"use client";

import { useEffect, useRef, useState } from "react";
import type { ReviewReport } from "@openwork/review";
import { CopyButton } from "./copy-button";
import { Icon } from "./icons";
import { OpenCheckpoint } from "./open-checkpoint";
import { StatusIcon } from "./status-icon";

export function EvidenceViewer({ report, id, checkpointProviders = [] }: { report: ReviewReport; id: string; checkpointProviders?: readonly string[] }) {
  const images = report.evidence.filter((item) => item.kind === "image");
  const [selected, setSelected] = useState<string | null>(null);
  const [actualSize, setActualSize] = useState(false);
  const [showNotes, setShowNotes] = useState(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const index = images.findIndex((item) => item.id === selected);
  const item = images[index];
  const source = item && report.sources.find((entry) => entry.id === item.sourceId);
  const assertions = report.evidence.filter((entry) => entry.sourceId === item?.sourceId && entry.kind === "assertion").flatMap((entry) => entry.judgments);
  const notes = item?.designNotes ?? [];

  useEffect(() => {
    function sync() {
      setSelected(window.location.hash.startsWith("#evidence-") ? window.location.hash.slice(10) : null);
      setActualSize(false);
    }
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  useEffect(() => {
    if (item && !dialog.current?.open) dialog.current?.showModal();
    if (!item && dialog.current?.open) dialog.current?.close();
  }, [item]);
  function close() {
    setSelected(null);
    if (window.location.hash.startsWith("#evidence-")) history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  function move(offset: number) {
    const next = images[index + offset];
    if (next) window.location.hash = `evidence-${next.id}`;
  }
  return <dialog ref={dialog} className="evidence-viewer" aria-labelledby="viewer-title" onClose={close} onKeyDown={(event) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
  }}>
    {item && <>
      <header className="viewer-toolbar">
        <div className="viewer-heading">
          <h2 id="viewer-title">{item.caption}</h2>
          {source && <p>{source.name}</p>}
        </div>
        <span className="viewer-count">{index + 1} of {images.length}</span>
        <div className="button-group">
          <button type="button" onClick={() => move(-1)} disabled={index === 0} aria-keyshortcuts="ArrowLeft">Previous <kbd>←</kbd></button>
          <button type="button" onClick={() => move(1)} disabled={index === images.length - 1} aria-keyshortcuts="ArrowRight">Next <kbd>→</kbd></button>
        </div>
        <button type="button" aria-pressed={actualSize} onClick={() => setActualSize(!actualSize)}>{actualSize ? "Fit to width" : "100% zoom"}</button>
        {notes.length > 0 && <button type="button" aria-pressed={showNotes} onClick={() => setShowNotes(!showNotes)}>{showNotes ? "Hide design notes" : "Show design notes"}</button>}
        <button type="button" className="quiet" onClick={() => dialog.current?.close()}>Close <kbd>esc</kbd></button>
      </header>
      <div className="viewer-body">
        <div className={`viewer-image${actualSize ? " actual-size" : ""}`} tabIndex={0} aria-label="Screenshot">
          <div className="viewer-shot">
            <img src={`/r/${id}/assets/${item.asset}`} alt={item.caption} />
            {showNotes && notes.map((note, noteIndex) => note.region && (
              <span key={noteIndex} className={`design-region ${note.severity}`} aria-hidden style={{ left: `${note.region.x * 100}%`, top: `${note.region.y * 100}%`, width: `${note.region.width * 100}%`, height: `${note.region.height * 100}%` }}>
                <span className="design-marker">{noteIndex + 1}</span>
              </span>
            ))}
          </div>
        </div>
        <aside className="viewer-context" aria-label="Evidence context">
          <div className="viewer-block">
            <OpenCheckpoint key={item.id} id={id} image={item} connected={Boolean(item.checkpoint && checkpointProviders.includes(item.checkpoint.provider))} />
          </div>
          {item.description && <p className="viewer-description">{item.description}</p>}
          <div className="viewer-meta">
            <code>{report.gitSha.slice(0, 7)}</code>
            <CopyButton label="Copy image link" value={`#evidence-${item.id}`} link />
          </div>
          <h3>Visual checks</h3>
          {!item.judgments.length && <p className="viewer-empty">No visual judgment recorded.</p>}
          {item.judgments.map((judgment, index) => <div className={`viewer-judgment ${judgment.state}`} key={index}>
            <StatusIcon state={judgment.state} size={14} />
            <div><strong>{judgment.expectation}</strong><span className={`result ${judgment.state}`}>{judgment.state}</span><p>{judgment.reasoning}</p></div>
          </div>)}
          {notes.length > 0 && <><h3>Design notes</h3>
            <p className="design-notes-hint">Advisory: these do not change the verdict.</p>
            {notes.map((note, noteIndex) => <div className="viewer-judgment design-note" key={noteIndex}>
              <span className={`design-marker ${note.severity}`}>{noteIndex + 1}</span>
              <div>
                <strong>{note.title}</strong>
                <span className={`result ${note.severity === "medium" ? "pending" : ""}`}>{note.severity === "medium" ? "Worth fixing" : "Minor"} · <code>{note.rule}</code> · {note.source === "layout" ? "measured" : "judged"}</span>
                <p>{note.detail}</p>
                {(note.anchors?.length || note.classes?.length) ? <p className="design-note-where">Where in the code: {[...(note.anchors ?? []), ...(note.classes ?? []).map((value) => `class "${value}"`)].map((hook) => <code key={hook}>{hook}</code>)}</p> : null}
              </div>
            </div>)}
          </>}
          {assertions.length > 0 && <><h3>Source assertions</h3>{assertions.map((judgment, index) => <div className={`viewer-judgment ${judgment.state}`} key={index}>
            <StatusIcon state={judgment.state} size={14} />
            <div><strong>{judgment.expectation}</strong><span className={`result ${judgment.state}`}>{judgment.state}</span><p>{judgment.reasoning}</p></div>
          </div>)}</>}
          {source && <a className="viewer-record" href={`/r/${id}/assets/${source.asset}`} target="_blank" rel="noreferrer">View record and trace<Icon name="externalLink" size={12} /></a>}
        </aside>
      </div>
    </>}
  </dialog>;
}
