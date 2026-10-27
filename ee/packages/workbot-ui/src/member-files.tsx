"use client";

import { Dialog } from "@base-ui/react/dialog";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Download, Plus, Trash2, Upload, X } from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  downloadWorkbotFile,
  uploadWorkbotMemberFile,
  useDecideWorkbotUpload,
  useDeleteWorkbotMemberFile,
  useWorkbotChat,
  useWorkbotFiles,
  useWorkbotMemberFiles,
  useWorkbotUploadApprovals,
  workbotMemberFilesKey,
  type WorkbotFile,
  type WorkbotMemberFile,
} from "./data";
import { FileBadge, FileRow, FilesPanel, formatSize, ImageThumb, isImage } from "./files";
import { dayLabel } from "./format";
import { useRetainedSurface, workbotHost } from "./host";
import { OpenFileContext } from "./open-file";

/**
 * My files (docs/features/member-files): the member's one file space, shared by all their chats, Workbot's computer and
 * its browser. The Files panel shows it by folder, with where each file came from; the chat's own attachments stay
 * under "Sent in this chat".
 */

/** Where a file came from, in the person's words (DESIGN C3): a browser download by the site it came from. */
export function originLabel(file: WorkbotMemberFile, assistantName: string) {
  const { origin } = file;
  if (origin.kind === "browser") {
    let host = "";
    try {
      host = origin.url ? new URL(origin.url).host : "";
    } catch {
      host = "";
    }
    return host ? `From ${host}` : "Downloaded in the browser";
  }
  if (origin.kind === "upload") return "Added by you";
  return `Made by ${!origin.agent || origin.agent === "workbot" ? assistantName : origin.agent}`;
}

/** A folder's name in the panel: the assistant's own folder by its name, nested folders with slashes. */
function folderLabel(folder: string, assistantName: string) {
  if (folder === "agents/workbot") return assistantName;
  const parts = folder.startsWith("agents/") ? folder.slice("agents/".length).split("/") : folder.split("/");
  if (folder.startsWith("agents/workbot/")) parts[0] = assistantName;
  return parts.join(" / ");
}

/** Downloads first, then the assistant's folder, then Uploads, then the rest by name; loose files before all of them. */
function folderRank(folder: string) {
  if (folder === "") return 0;
  if (folder === "Downloads") return 1;
  if (folder === "agents/workbot") return 2;
  if (folder === "Uploads") return 3;
  return 4;
}

function groupByFolder(files: WorkbotMemberFile[]) {
  const groups = new Map<string, WorkbotMemberFile[]>();
  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    const folder = slash < 0 ? "" : file.path.slice(0, slash);
    groups.set(folder, [...(groups.get(folder) ?? []), file]);
  }
  return [...groups]
    .map(([folder, entries]) => ({ folder, files: entries.sort((left, right) => right.updatedAt - left.updatedAt) }))
    .sort((left, right) => folderRank(left.folder) - folderRank(right.folder) || left.folder.localeCompare(right.folder));
}

const asAttachment = (file: WorkbotMemberFile) => ({ id: file.id, name: file.name, mediaType: file.mediaType, size: file.size, updatedAt: file.updatedAt });

function MemberFileRow({ file, assistantName, confirming, onConfirm, onCancel, onOpen }: {
  file: WorkbotMemberFile;
  assistantName: string;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onOpen: (file: WorkbotMemberFile) => void;
}) {
  const remove = useDeleteWorkbotMemberFile();
  const chat = useWorkbotChat();
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);
  // Esc backs out of the delete instead of closing the panel.
  const cancelOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onCancel();
  };
  return (
    <li className="group flex h-14 items-center gap-3 border-b border-[var(--wb-row-line)] pl-1 pr-1" data-member-file={file.path}>
      {isImage(file.mediaType) ? <ImageThumb id={file.id} className="h-9 w-8 shrink-0 rounded-[7px] shadow-[inset_0_0_0_1px_var(--wb-hairline)]" /> : <FileBadge name={file.name} mediaType={file.mediaType} />}
      <button type="button" onClick={() => onOpen(file)} title={`/files/${file.path}`} className="flex min-w-0 flex-1 flex-col gap-0.5 rounded text-left focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
        <span className="truncate text-[13px] font-medium leading-4 text-[var(--wb-text)] group-hover:underline group-hover:decoration-[var(--wb-disabled)] group-hover:underline-offset-2">{file.name}</span>
        <span className="truncate text-[12px] leading-4 text-[var(--wb-muted)]">
          {originLabel(file, assistantName)} · {dayLabel(file.updatedAt)} · {formatSize(file.size)}
        </span>
      </button>
      {confirming ? (
        <span className="flex shrink-0 items-center gap-1" onKeyDown={cancelOnEscape}>
          <button type="button" onClick={onCancel} className="h-8 rounded-full px-3 text-[13px] font-medium text-[var(--wb-muted)] hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
            Cancel
          </button>
          <button
            ref={confirmButton}
            type="button"
            disabled={remove.isPending}
            onClick={() => remove.mutate(file.id, { onSettled: onCancel })}
            aria-label={`Delete ${file.name} from My files`}
            className="h-8 rounded-full bg-[var(--wb-danger)] px-3 text-[13px] font-medium text-[var(--wb-mark-text)] transition-opacity duration-150 disabled:opacity-60 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
          >
            Delete
          </button>
        </span>
      ) : (
        <>
          <button
            type="button"
            onClick={onConfirm}
            aria-label={`Delete ${file.name}`}
            title="Delete"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[var(--wb-muted)] opacity-0 transition-opacity duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-danger)] group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] [@media(hover:none)]:opacity-100"
          >
            <Trash2 size={15} strokeWidth={1.75} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => void downloadWorkbotFile(file, chat)}
            aria-label={`Download ${file.name}`}
            title="Download"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[var(--wb-muted)] transition-colors duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
          >
            <Download size={15} strokeWidth={1.75} aria-hidden />
          </button>
        </>
      )}
    </li>
  );
}

type Adding = { key: string; name: string; size: number; loaded: number; error: string | null };

/** Files being added, where they will appear (DESIGN P11): progress, or why it failed. */
function AddingRow({ adding, onDismiss }: { adding: Adding; onDismiss: () => void }) {
  return (
    <li className="flex h-14 items-center gap-3 border-b border-[var(--wb-row-line)] pl-1 pr-1">
      <FileBadge name={adding.name} mediaType="" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium leading-4 text-[var(--wb-text)]">{adding.name}</span>
        <span className={`truncate text-[12px] leading-4 ${adding.error ? "text-[var(--wb-danger)]" : "text-[var(--wb-muted)]"}`}>
          {adding.error ?? `Adding · ${formatSize(adding.loaded)} of ${formatSize(adding.size)}`}
        </span>
      </span>
      {adding.error ? (
        <button type="button" onClick={onDismiss} aria-label={`Dismiss ${adding.name}`} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[var(--wb-muted)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      ) : null}
    </li>
  );
}

function SectionLabel({ children, count }: { children: ReactNode; count: number }) {
  return (
    <li className="flex h-9 items-end justify-between px-1 pb-1.5 text-[12px] font-medium leading-4 text-[var(--wb-muted)]">
      <span className="truncate">{children}</span>
      <span className="tabular-nums">{count}</span>
    </li>
  );
}

/** The chat's own attachments, folded away: My files is what the panel is for (DESIGN P3). */
function SentInThisChat({ assistantName, enabled, onOpenFile }: { assistantName: string; enabled: boolean; onOpenFile: (file: WorkbotFile) => void }) {
  const files = useWorkbotFiles(enabled);
  const list = files.data?.files ?? [];
  if (list.length === 0) return null;
  return (
    <details className="group/sent mt-3">
      <summary className="flex h-10 cursor-pointer list-none items-center gap-1.5 rounded px-1 text-[13px] font-medium text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] [&::-webkit-details-marker]:hidden">
        <ChevronRight size={14} strokeWidth={2} aria-hidden className="text-[var(--wb-muted)] transition-transform duration-150 ease-out group-open/sent:rotate-90 motion-reduce:transition-none" />
        Sent in this chat
        <span className="ml-auto text-[12px] font-normal tabular-nums text-[var(--wb-muted)]">{list.length}</span>
      </summary>
      <ul>{list.map((file) => <FileRow key={file.id} file={file} assistantName={assistantName} onOpen={onOpenFile} />)}</ul>
    </details>
  );
}

export function MemberFilesPanel({ open, onClose, assistantName, onOpenFile }: { open: boolean; onClose: () => void; assistantName: string; onOpenFile: (file: { id: string; name: string; mediaType: string; size: number; updatedAt?: number }) => void }) {
  const surface = useRetainedSurface(open);
  const files = useWorkbotMemberFiles(surface.open);
  const queryClient = useQueryClient();
  const picker = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState<Adding[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const list = files.data?.files ?? [];
  const groups = useMemo(() => groupByFolder(list), [list]);
  const usage = files.data?.usage ?? null;
  const add = useCallback(
    (picked: FileList) => {
      for (const file of Array.from(picked)) {
        const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
        setAdding((current) => [...current, { key, name: file.name, size: file.size, loaded: 0, error: null }]);
        const controller = new AbortController();
        void uploadWorkbotMemberFile(file, (loaded) => setAdding((current) => current.map((entry) => (entry.key === key ? { ...entry, loaded } : entry))), controller.signal)
          .then(async () => {
            await queryClient.invalidateQueries({ queryKey: workbotMemberFilesKey });
            setAdding((current) => current.filter((entry) => entry.key !== key));
          })
          .catch((error: unknown) => setAdding((current) => current.map((entry) => (entry.key === key ? { ...entry, error: error instanceof Error ? error.message : "Couldn't add it." } : entry))));
      }
    },
    [queryClient],
  );
  const openFile = (file: WorkbotMemberFile) => onOpenFile(asAttachment(file));
  const total = usage?.bytes ?? list.reduce((sum, file) => sum + file.size, 0);
  const addButton = (
    <button
      type="button"
      onClick={() => picker.current?.click()}
      className="flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-[var(--wb-text)] transition-colors duration-150 hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
    >
      <Plus size={15} strokeWidth={1.75} aria-hidden />
      Add files
    </button>
  );
  return (
    <Dialog.Root open={surface.open} onOpenChange={(next) => { if (!surface.blocked && !next) onClose(); }}>
      <Dialog.Portal {...surface.portal}>
        <Dialog.Popup data-workbot-member-files className="workbot fixed inset-y-0 right-0 z-50 flex w-full max-w-[400px] flex-col bg-[var(--wb-surface)] shadow-[var(--wb-sheet-shadow)] outline-none transition-transform duration-200 ease-out data-[ending-style]:translate-x-full data-[starting-style]:translate-x-full motion-reduce:transition-none">
          <div className="flex h-15 shrink-0 items-center justify-between border-b border-[var(--wb-hairline)] pl-6 pr-4">
            <Dialog.Title className="text-[15px] font-semibold leading-[18px] tracking-[-0.01em] text-[var(--wb-text)]">My files</Dialog.Title>
            <Dialog.Close aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-[var(--wb-muted)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
              <X size={14} strokeWidth={2} aria-hidden />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto pb-2 pl-5 pr-4 pt-1">
            {files.isPending ? (
              <ul aria-busy="true">
                {[0, 1, 2, 3].map((index) => (
                  <li key={index} className="flex h-14 items-center gap-3 border-b border-[var(--wb-row-line)] pl-1">
                    <span className="h-9 w-8 rounded-[7px] bg-[var(--wb-chip)]" />
                    <span className="flex flex-col gap-1.5"><span className="h-3 w-40 rounded bg-[var(--wb-chip)]" /><span className="h-3 w-28 rounded bg-[var(--wb-chip)]" /></span>
                  </li>
                ))}
              </ul>
            ) : files.isError ? (
              <p className="px-1 py-4 text-[13px] text-[var(--wb-muted)]">
                Couldn&apos;t load your files.{" "}
                <button type="button" onClick={() => void files.refetch()} className="font-medium text-[var(--wb-text)] underline underline-offset-2">Try again</button>
              </p>
            ) : files.data && !files.data.enabled ? (
              <p className="px-1 py-4 text-[13px] leading-5 text-[var(--wb-muted)]">My files aren&apos;t set up on this server. Your admin can turn them on.</p>
            ) : list.length === 0 && adding.length === 0 ? (
              <div className="flex flex-col items-start gap-3 px-1 py-4">
                <p className="text-[13px] leading-5 text-[var(--wb-muted)]">Browser downloads, files {assistantName} makes and files you add show up here, in every chat.</p>
                {addButton}
              </div>
            ) : (
              <ul>
                {adding.length ? <SectionLabel count={adding.length}>Adding</SectionLabel> : null}
                {adding.map((entry) => <AddingRow key={entry.key} adding={entry} onDismiss={() => setAdding((current) => current.filter((item) => item.key !== entry.key))} />)}
                {groups.map((group) => (
                  <GroupRows key={group.folder || "top"} label={group.folder ? folderLabel(group.folder, assistantName) : null} count={group.files.length}>
                    {group.files.map((file) => (
                      <MemberFileRow key={file.id} file={file} assistantName={assistantName} confirming={confirming === file.id} onConfirm={() => setConfirming(file.id)} onCancel={() => setConfirming(null)} onOpen={openFile} />
                    ))}
                  </GroupRows>
                ))}
              </ul>
            )}
            <SentInThisChat assistantName={assistantName} enabled={surface.open} onOpenFile={(file) => onOpenFile(file)} />
          </div>
          {list.length > 0 ? (
            <div className="flex h-[52px] shrink-0 items-center justify-between border-t border-[var(--wb-hairline)] pl-6 pr-4 text-[12px] leading-4 text-[var(--wb-muted)]">
              <span className="tabular-nums">
                {list.length} {list.length === 1 ? "file" : "files"} · {formatSize(total)}{usage ? ` of ${formatSize(usage.maxBytes)}` : ""}
              </span>
              {addButton}
            </div>
          ) : null}
          <input
            ref={picker}
            data-member-files-input
            aria-label="Add files to My files"
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files?.length) add(event.target.files);
              event.target.value = "";
            }}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function GroupRows({ label, count, children }: { label: string | null; count: number; children: ReactNode }) {
  return (
    <>
      {label ? <SectionLabel count={count}>{label}</SectionLabel> : null}
      {children}
    </>
  );
}

/**
 * A `/files/...` link in an answer: opens the file beside the chat when it is in My files; plain words otherwise (a
 * file not saved yet, or one deleted since).
 */
export function MemberFileLink({ path, children }: { path: string; children: ReactNode }) {
  const enabled = workbotHost().memberFiles === true;
  const files = useWorkbotMemberFiles(enabled);
  const open = useContext(OpenFileContext);
  const found = files.data?.files.find((file) => file.path === path);
  const refetched = useRef(false);
  useEffect(() => {
    // Written by the answer that links it, after the list was read: read it once more.
    if (enabled && files.isSuccess && !found && !refetched.current) {
      refetched.current = true;
      void files.refetch();
    }
  }, [enabled, files, found]);
  if (!enabled || !found) return <span className="font-medium">{children}</span>;
  return (
    <button
      type="button"
      onClick={() => open(asAttachment(found))}
      title={`Open /files/${found.path}`}
      className="inline rounded font-medium text-[var(--wb-text)] underline decoration-[var(--wb-disabled)] underline-offset-2 hover:decoration-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
    >
      {children}
    </button>
  );
}

/** The Files panel: the member's My files where that is on, otherwise the chat's kept files, as before. */
export function WorkbotFilesPanel(props: { open: boolean; onClose: () => void; assistantName: string; onOpenFile: (file: WorkbotFile | { id: string; name: string; mediaType: string; size: number; updatedAt?: number }) => void }) {
  return workbotHost().memberFiles ? <MemberFilesPanel {...props} /> : <FilesPanel {...props} />;
}

/**
 * The person's answer to an upload the agent asked to make (DESIGN T4, P9): what goes where, as one sentence, with
 * Upload and Don't upload. A page can talk the agent into uploading, so nothing leaves My files without this answer.
 * Approving also tells the agent to go ahead, as the person's message.
 */
export function UploadApprovals({ version, onAnswered }: { version: string; onAnswered: (text: string) => void }) {
  const enabled = workbotHost().memberFiles === true;
  const approvals = useWorkbotUploadApprovals(enabled, version);
  const decide = useDecideWorkbotUpload();
  const approval = approvals.data?.[0];
  if (!enabled || !approval) return null;
  const names = approval.files.map((file) => file.name).join(", ");
  const answer = (decision: "approve" | "decline") =>
    decide.mutate({ id: approval.id, decision }, {
      onSuccess: () => onAnswered(decision === "approve" ? `Go ahead: upload ${names} to ${approval.host}.` : `Don't upload ${names} to ${approval.host}.`),
    });
  return (
    <div data-workbot-upload-approval role="group" aria-label={`Upload ${names} to ${approval.host}`} className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-[var(--wb-surface)] px-4 py-3 shadow-[0_0_0_1px_var(--wb-ring)]">
      <Upload size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-[var(--wb-muted)]" />
      <p className="min-w-0 flex-1 text-[13px] leading-5 text-[var(--wb-text)]">
        Upload <span className="font-medium">{names}</span> from My files to <span className="font-medium">{approval.host}</span>? The site keeps a copy.
      </p>
      {decide.isError ? <span role="alert" className="text-[12px] text-[var(--wb-danger)]">{decide.error.message}</span> : null}
      <span className="flex shrink-0 items-center gap-1">
        <button type="button" disabled={decide.isPending} onClick={() => answer("decline")} className="h-8 rounded-full px-3 text-[13px] font-medium text-[var(--wb-muted)] hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] disabled:opacity-60 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
          Don&apos;t upload
        </button>
        <button type="button" disabled={decide.isPending} onClick={() => answer("approve")} className="h-8 rounded-full bg-[var(--wb-ink)] px-4 text-[13px] font-medium text-[var(--wb-mark-text)] disabled:opacity-60 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
          Upload
        </button>
      </span>
    </div>
  );
}
