import { posix } from "node:path"
import { z } from "zod"
import type { ComputerMemberFiles, MemberFileEntry } from "./types.js"

/**
 * My files on the computer: /files mirrors the member's space (docs/features/member-files), synced around every call.
 * The runner moves bytes over the provider's file API; nothing in the VM can reach the store.
 *
 * The VM keeps a manifest (path → the My files version it last saw, and the file's size and mtime then), so each side's
 * changes since the last sync are known:
 *
 * - changed only in My files: written to /files; deleted only in My files: removed from /files;
 * - changed only on the computer: saved to My files if it still has the version the computer saw (compare and swap);
 *   deleted only on the computer: deleted in My files if unchanged there;
 * - changed on both: My files keeps the name, the computer's version is saved beside it as "<name> (computer copy)";
 *   an edit always beats a delete. Nothing is overwritten silently.
 */

export const MEMBER_FILES_DIR = "/files"
export const MEMBER_FILES_MANIFEST = "/workspace/.jobs/.member-files.json"
/** At most this much of My files is copied onto one computer, newest first; the rest stays readable with read_file. */
export const MAX_PULL_BYTES = 2 * 1024 * 1024 * 1024

/** A file under /files on the computer: its path inside My files, size, signature (size and mtime) and origin URL. */
export type LocalFile = { path: string; size: number; sig: string; url: string | null }
/** What the computer's /files last matched in My files: the version (null for a file that never got there), and its signature. */
type ManifestEntry = { v: number | null; s: string }
export type Manifest = Record<string, ManifestEntry>
const manifestSchema = z.record(z.string(), z.object({ v: z.number().int().nullable(), s: z.string() })).catch({})

/** The computer's side of a sync; providerMirror does it with commands and the file API, tests in memory. */
export interface MirrorVm {
  /** Every synced file under /files, and the manifest as stored (any JSON; unreadable counts as none). */
  scan(): Promise<{ files: LocalFile[]; manifest: unknown }>
  read(path: string): Promise<Uint8Array<ArrayBuffer>>
  /** Creates these folders (paths inside My files) where missing. */
  folders(paths: string[]): Promise<void>
  write(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>
  /** Each existing file's signature after writing it. */
  signatures(paths: string[]): Promise<Map<string, string>>
  remove(paths: string[]): Promise<void>
  saveManifest(manifest: Manifest): Promise<void>
}

/** What one sync did that the model, and through it the person, should know. Paths are inside My files. */
export type SyncReport = {
  saved: string[]
  /** In My files but couldn't be written here (a folder on this computer has the name). */
  notPulled: string[]
  deleted: string[]
  copies: Array<{ path: string; copy: string }>
  notSaved: string[]
  notCopied: { count: number; bytes: number }
  pulled: number
  /** My files' versions now mirrored here (path:version), to skip a sync when nothing changed. */
  stamp: string
}

const shown = (path: string) => `${MEMBER_FILES_DIR}/${path}`

/** `report (computer copy).docx`, `report (computer copy 2).docx`, …: the first name nobody uses. */
export function copyName(path: string, taken: (candidate: string) => boolean) {
  const folder = posix.dirname(path)
  const name = posix.basename(path)
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ""
  for (let attempt = 1; ; attempt += 1) {
    const candidate = `${stem} (computer copy${attempt > 1 ? ` ${attempt}` : ""})${extension}`
    const full = folder === "." ? candidate : `${folder}/${candidate}`
    if (!taken(full)) return full
  }
}

export function stampOf(entries: Array<{ path: string; version: number }>) {
  return entries
    .map((entry) => `${entry.path}:${entry.version}`)
    .sort()
    .join("\n")
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${Number((bytes / (1024 * 1024 * 1024)).toFixed(1))} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} bytes`
}

const sameBytes = (left: Uint8Array, right: Uint8Array) => left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])

/**
 * One two-way sync of /files with My files. `kind` is who made the computer's changes: the browser (a desktop browser
 * call, whose downloads land in /files/Downloads) or the computer (commands and apps).
 */
export async function syncMemberFiles(vm: MirrorVm, member: ComputerMemberFiles, kind: "computer" | "browser", options: { maxPullBytes?: number; remote?: MemberFileEntry[] } = {}): Promise<SyncReport> {
  const scanned = await vm.scan()
  const manifest = manifestSchema.parse(scanned.manifest)
  const next: Manifest = { ...manifest }
  const local = new Map(scanned.files.map((file) => [file.path, file]))
  const remote = new Map((options.remote ?? (await member.list())).map((file) => [file.path, file]))
  const report: SyncReport = { saved: [], notPulled: [], deleted: [], copies: [], notSaved: [], notCopied: { count: 0, bytes: 0 }, pulled: 0, stamp: "" }
  const pulls = new Map<string, MemberFileEntry>()
  const removals: string[] = []
  const reserved = new Set<string>()
  const taken = (path: string) => local.has(path) || remote.has(path) || reserved.has(path)

  /** Keeps the computer's version where it can't be saved; it stays here, and is reported once. */
  const keepLocal = (path: string, file: LocalFile, reason: string) => {
    report.notSaved.push(`${shown(path)} (${reason})`)
    next[path] = { v: manifest[path]?.v ?? null, s: file.sig }
  }

  /** The computer's version of `path` saved beside My files' one, which then takes the name here too. */
  const keepBoth = async (path: string, file: LocalFile) => {
    const copy = copyName(path, taken)
    reserved.add(copy)
    if (!member.canWrite(copy)) report.notSaved.push(`${shown(path)} (changed in My files too; ${member.refusal(copy)})`)
    else if (file.size > member.maxFileBytes) report.notSaved.push(`${shown(path)} (changed in My files too, and ${formatBytes(file.size)} is over the ${formatBytes(member.maxFileBytes)} limit)`)
    else {
      const saved = await member.write(copy, await vm.read(path), { kind, ifVersion: null, url: file.url })
      if (saved.ok) {
        report.copies.push({ path, copy })
        pulls.set(copy, saved.file)
      } else report.notSaved.push(`${shown(path)} (changed in My files too; ${saved.message})`)
    }
    const current = (await member.list()).find((entry) => entry.path === path)
    if (current) pulls.set(path, current)
    else delete next[path]
  }

  const push = async (path: string, file: LocalFile, ifVersion: number | null) => {
    if (!member.canWrite(path)) return keepLocal(path, file, member.refusal(path))
    if (file.size > member.maxFileBytes) return keepLocal(path, file, `${formatBytes(file.size)}; the most a file in My files can be is ${formatBytes(member.maxFileBytes)}`)
    // Gone since the scan (a command still running): the next sync sees what is there then.
    const bytes = await vm.read(path).catch(() => null)
    if (!bytes) return
    const saved = await member.write(path, bytes, { kind, ifVersion, url: file.url })
    if (saved.ok) {
      next[path] = { v: saved.file.version, s: file.sig }
      report.saved.push(path)
      return
    }
    if (saved.code === "conflict") return keepBoth(path, file)
    keepLocal(path, file, saved.message)
  }

  for (const path of [...new Set([...local.keys(), ...remote.keys(), ...Object.keys(manifest)])].sort()) {
    const here = local.get(path)
    const there = remote.get(path)
    const last = manifest[path]
    const known = last !== undefined && last.v !== null
    const changedHere = here !== undefined && (last === undefined || last.s !== here.sig)
    const changedThere = there !== undefined && (!known || last.v !== there.version)
    if (!here && !there) {
      delete next[path]
      continue
    }
    if (here && changedHere) {
      if (there && changedThere) {
        // Both sides have a version this computer never saw on the other: the same bytes are one file.
        if (!known && there.size === here.size) {
          const theirs = await member.read(path)
          if (theirs && sameBytes(theirs.bytes, await vm.read(path))) {
            next[path] = { v: theirs.file.version, s: here.sig }
            continue
          }
        }
        await keepBoth(path, here)
        continue
      }
      // Changed here and unchanged there (or deleted there: an edit beats a delete, so it comes back).
      await push(path, here, there ? there.version : null)
      continue
    }
    if (here) {
      // Unchanged here since the last sync.
      if (there && changedThere) pulls.set(path, there)
      else if (!there && known) {
        removals.push(path)
        delete next[path]
      }
      continue
    }
    // Not here: new in My files, or deleted on this computer.
    if (!last) {
      if (there) pulls.set(path, there)
      continue
    }
    if (!known || !there) {
      delete next[path]
      continue
    }
    if (changedThere) {
      pulls.set(path, there)
      continue
    }
    if (!member.canWrite(path)) {
      report.notSaved.push(`${shown(path)} (put back: ${member.refusal(path)})`)
      pulls.set(path, there)
      continue
    }
    const deleted = await member.delete(path, there.version)
    if (deleted.ok) {
      report.deleted.push(path)
      delete next[path]
    } else if (deleted.code === "conflict") {
      const current = (await member.list()).find((entry) => entry.path === path)
      if (current) pulls.set(path, current)
    } else delete next[path]
  }

  if (removals.length) await vm.remove(removals)

  // Newest first, within what one computer holds.
  let mirrored = [...remote.values()].filter((file) => next[file.path]?.v !== null && next[file.path] !== undefined && !pulls.has(file.path)).reduce((sum, file) => sum + file.size, 0)
  const budget = options.maxPullBytes ?? MAX_PULL_BYTES
  const wanted = [...pulls.values()].sort((left, right) => right.updatedAt - left.updatedAt)
  const pulled: Array<{ path: string; version: number }> = []
  const folders = new Set(wanted.map((file) => posix.dirname(file.path)).filter((folder) => folder !== "."))
  if (folders.size) await vm.folders([...folders])
  for (const entry of wanted) {
    if (mirrored + entry.size > budget) {
      report.notCopied.count += 1
      report.notCopied.bytes += entry.size
      delete next[entry.path]
      continue
    }
    const found = await member.read(entry.path)
    if (!found) continue
    try {
      await vm.write(entry.path, found.bytes)
    } catch {
      // A folder (or a file in the way of its folder) on this computer has the name: My files keeps it; not copied here.
      report.notPulled.push(entry.path)
      delete next[entry.path]
      continue
    }
    mirrored += found.file.size
    pulled.push({ path: entry.path, version: found.file.version })
  }
  if (pulled.length) {
    const signatures = await vm.signatures(pulled.map((entry) => entry.path))
    for (const entry of pulled) {
      const sig = signatures.get(entry.path)
      if (sig) next[entry.path] = { v: entry.version, s: sig }
    }
  }
  report.pulled = pulled.length
  if (JSON.stringify(next) !== JSON.stringify(manifest)) await vm.saveManifest(next)
  report.stamp = stampOf(Object.entries(next).flatMap(([path, entry]) => (entry.v === null ? [] : [{ path, version: entry.v }])))
  return report
}

/** The lines a tool result gets about a sync; empty when there is nothing to say. */
export function syncNotes(report: SyncReport | null) {
  if (!report) return []
  return [
    report.saved.length ? `[Saved to My files: ${report.saved.map(shown).join(", ")}]` : "",
    report.deleted.length ? `[Deleted from My files: ${report.deleted.map(shown).join(", ")}]` : "",
    ...report.copies.map((entry) => `[Kept both: ${shown(entry.path)} changed in My files too, so this computer's version was saved as ${shown(entry.copy)}]`),
    report.notSaved.length ? `[Not saved to My files: ${report.notSaved.join("; ")}]` : "",
    report.notPulled.length ? `[Not copied to this computer: ${report.notPulled.map(shown).join(", ")} (something here already has that name). Read them with read_file.]` : "",
    report.notCopied.count
      ? `[${report.notCopied.count} of their files (${formatBytes(report.notCopied.bytes)}) are in My files but not on this computer, which holds at most ${formatBytes(MAX_PULL_BYTES)} of them. Read them with read_file.]`
      : "",
  ].filter(Boolean)
}

/** Lists /files with sizes, mtimes and Chromium's origin URL, skipping hidden, partial and lock files and links. */
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

/** Folders, signatures and removals for a list of paths inside /files (JSON in MEMBER_PATHS). */
export const PATHS_SCRIPT = `
import json, os, sys
root, action = sys.argv[1], sys.argv[2]
paths = json.loads(os.environ['MEMBER_PATHS'])
out = {}
for path in paths:
    full = os.path.join(root, path)
    if os.path.commonpath([root, os.path.abspath(full)]) != root:
        continue
    try:
        if action == 'folders':
            os.makedirs(full, exist_ok=True)
        elif action == 'remove':
            if os.path.isfile(full) and not os.path.islink(full):
                os.remove(full)
        else:
            info = os.lstat(full)
            out[path] = '%d:%d' % (info.st_size, info.st_mtime_ns)
    except OSError:
        pass
print(json.dumps(out))
`

export const MEMBER_MANIFEST_MARKER = "---member-files-manifest---"
const scannedSchema = z.array(z.tuple([z.string(), z.number(), z.string(), z.string().nullable()]))
const signaturesSchema = z.record(z.string(), z.string())

/** The JSON a scan printed, then the manifest; garbage (an older image without python) reads as nothing. */
export function parseScan(stdout: string): { files: LocalFile[]; manifest: unknown } {
  const [listed = "[]", manifestText = "{}"] = stdout.split(`${MEMBER_MANIFEST_MARKER}\n`)
  const files = scannedSchema.catch([]).parse(safeJson(listed.trim()))
  return { files: files.map(([path, size, sig, url]) => ({ path, size, sig, url })), manifest: safeJson(manifestText.trim()) }
}

export function parseSignatures(stdout: string) {
  return new Map(Object.entries(signaturesSchema.catch({}).parse(safeJson(stdout.trim()))))
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
