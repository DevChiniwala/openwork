import { createHash } from "node:crypto"
import { posix } from "node:path"
import { z } from "zod"
import type { ComputerMemberFiles } from "./types.js"

/**
 * The browser and the member's My files (docs/features/member-files): downloads land in /files/Downloads on the
 * computer (the desktop bridge points the browser's Downloads there) and are saved to My files after each browser call;
 * a file the agent uploads to a page is copied from My files onto the computer just before, under /files/.uploads.
 * The runner moves bytes over the provider's file API; nothing on the computer can reach the store.
 */

export const FILES_DIR = "/files"
export const DOWNLOADS_DIR = `${FILES_DIR}/Downloads`
/** Copies of My files the browser uploads from: hidden, never collected as downloads. */
export const UPLOADS_DIR = `${FILES_DIR}/.uploads`
/** Which downloads were already saved (path → size:mtime), kept on the computer itself. */
export const DOWNLOADS_MANIFEST = "/workspace/.jobs/.member-downloads.json"
export const DOWNLOADS_MARKER = "---member-downloads---"
/** At most this many files go to one upload control at once. */
export const MAX_UPLOAD_FILES = 10

/** A finished download under /files/Downloads: its path there, size, signature (size and mtime) and the page it came from. */
export type Download = { path: string; size: number; sig: string; url: string | null }

/** The computer's side: what /files/Downloads holds, and reading one of them. */
export interface DownloadsVm {
  scan(): Promise<{ files: Download[]; manifest: unknown }>
  read(path: string): Promise<Uint8Array<ArrayBuffer>>
  saveManifest(manifest: Record<string, string>): Promise<void>
}

export type DownloadsReport = { saved: string[]; notSaved: string[] }

const manifestSchema = z.record(z.string(), z.string()).catch({})

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${Number((bytes / (1024 * 1024 * 1024)).toFixed(1))} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} bytes`
}

/** `report.pdf`, then `report (2).pdf`, … inside `folder`. */
export function numbered(folder: string, relative: string, attempt: number) {
  const name = posix.basename(relative)
  const parent = posix.dirname(relative)
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ""
  const file = attempt === 1 ? name : `${stem} (${attempt})${extension}`
  return [folder, parent === "." ? "" : parent, file].filter(Boolean).join("/")
}

/**
 * Saves new downloads to My files, each once, attributed to the browser with the page it came from. A download never
 * replaces a file already in My files: it gets the next free name. A background run saves to its agent folder.
 */
export async function collectDownloads(vm: DownloadsVm, member: ComputerMemberFiles): Promise<DownloadsReport> {
  const scanned = await vm.scan()
  const manifest = manifestSchema.parse(scanned.manifest)
  const next = { ...manifest }
  const report: DownloadsReport = { saved: [], notSaved: [] }
  for (const download of scanned.files) {
    if (manifest[download.path] === download.sig) continue
    // Said once: a download that can't be kept isn't reported after every call.
    next[download.path] = download.sig
    const folder = member.downloads
    if (folder === null) {
      report.notSaved.push(`${DOWNLOADS_DIR}/${download.path} (this run can't save files)`)
      continue
    }
    if (download.size > member.maxFileBytes) {
      report.notSaved.push(`${DOWNLOADS_DIR}/${download.path} (${formatBytes(download.size)}; the most a file in My files can be is ${formatBytes(member.maxFileBytes)})`)
      continue
    }
    // Gone since the scan: the next call sees what is there then.
    const bytes = await vm.read(download.path).catch(() => null)
    if (!bytes) {
      delete next[download.path]
      continue
    }
    let saved: string | null = null
    let refusal: string | null = null
    for (let attempt = 1; attempt <= 50 && !saved && !refusal; attempt += 1) {
      const target = numbered(folder, download.path, attempt)
      const written = await member.write(target, bytes, { kind: "browser", ifVersion: null, url: download.url })
      if (written.ok) saved = target
      else if (written.code !== "conflict") refusal = written.message
    }
    if (saved) report.saved.push(saved)
    else report.notSaved.push(`${DOWNLOADS_DIR}/${download.path} (${refusal ?? "no free name"})`)
  }
  if (JSON.stringify(next) !== JSON.stringify(manifest)) await vm.saveManifest(next)
  return report
}

/** Where an upload's copy of a My files file goes on the computer: same name, one folder per version. */
export function uploadPath(path: string, version: number) {
  return `${UPLOADS_DIR}/${createHash("sha256").update(`${path}\n${version}`).digest("hex").slice(0, 16)}/${posix.basename(path)}`
}

/** The lines a browser result gets about My files; empty when there is nothing to say. */
export function downloadNotes(report: DownloadsReport | null) {
  if (!report) return []
  return [
    report.saved.length ? `[Saved to My files: ${report.saved.map((path) => `${FILES_DIR}/${path}`).join(", ")}]` : "",
    report.notSaved.length ? `[Not saved to My files: ${report.notSaved.join("; ")}]` : "",
  ].filter(Boolean)
}

/** Lists finished downloads with sizes, mtimes and Chromium's origin URL; skips partial, hidden and lock files and links. */
export const SCAN_SCRIPT = `
import json, os, stat, sys
root = sys.argv[1]
partial = ('.crdownload', '.part', '.partial', '.download', '.tmp')
out = []
for directory, folders, names in os.walk(root):
    folders[:] = sorted(f for f in folders if not f.startswith('.'))
    for name in sorted(names):
        if name.startswith('.') or name.startswith('~$') or name.endswith(partial):
            continue
        full = os.path.join(directory, name)
        relative = os.path.relpath(full, root)
        try:
            relative.encode('utf-8')
            info = os.lstat(full)
        except (OSError, UnicodeEncodeError):
            continue
        if not stat.S_ISREG(info.st_mode):
            continue
        url = None
        try:
            url = os.getxattr(full, 'user.xdg.origin.url').decode('utf-8', 'replace')[:2048]
        except (OSError, AttributeError):
            pass
        out.append([relative, info.st_size, '%d:%d' % (info.st_size, info.st_mtime_ns), url])
print(json.dumps(out))
`

const scannedSchema = z.array(z.tuple([z.string(), z.number(), z.string(), z.string().nullable()]))

/** The JSON a scan printed, then the manifest; garbage (an image without python) reads as nothing. */
export function parseScan(stdout: string): { files: Download[]; manifest: unknown } {
  const [listed = "[]", manifestText = "{}"] = stdout.split(`${DOWNLOADS_MARKER}\n`)
  const files = scannedSchema.catch([]).parse(safeJson(listed.trim()))
  return { files: files.map(([path, size, sig, url]) => ({ path, size, sig, url })), manifest: safeJson(manifestText.trim()) }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
