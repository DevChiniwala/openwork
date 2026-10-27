import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { collectDownloads, downloadNotes, numbered, parseScan, SCAN_SCRIPT, uploadPath, type Download, type DownloadsVm } from "./browser-files.js"
import type { ComputerMemberFiles, MemberFileEntry } from "./types.js"

const bytes = (text: string) => new Uint8Array(Buffer.from(text))

/** /files/Downloads on a computer, in memory. */
function downloadsFolder() {
  let clock = 1
  const files = new Map<string, { bytes: Uint8Array<ArrayBuffer>; mtime: number; url: string | null }>()
  let manifest: unknown = {}
  const vm: DownloadsVm = {
    async scan() {
      const listed: Download[] = [...files].map(([path, file]) => ({ path, size: file.bytes.byteLength, sig: `${file.bytes.byteLength}:${file.mtime}`, url: file.url }))
      return { files: listed, manifest }
    },
    async read(path) {
      const file = files.get(path)
      if (!file) throw new Error("gone")
      return new Uint8Array(file.bytes)
    },
    async saveManifest(next) {
      manifest = { ...next }
    },
  }
  return { vm, download: (path: string, content: string, url: string | null = null) => files.set(path, { bytes: bytes(content), mtime: clock++, url }) }
}

/** My files as one run sees them; `downloads` is where its downloads go (null: nowhere). */
function myFiles(input: { downloads?: string | null; maxFileBytes?: number } = {}) {
  const files = new Map<string, { bytes: Uint8Array<ArrayBuffer>; url: string | null }>()
  const entry = (path: string): MemberFileEntry => ({ path, size: files.get(path)?.bytes.byteLength ?? 0, version: 1, updatedAt: 1 })
  const member: ComputerMemberFiles = {
    maxFileBytes: input.maxFileBytes ?? 1024,
    downloads: input.downloads === undefined ? "Downloads" : input.downloads,
    async read(path) {
      const file = files.get(path)
      return file ? { file: entry(path), bytes: new Uint8Array(file.bytes) } : null
    },
    async write(path, content, write) {
      if (files.has(path)) return { ok: false, code: "conflict", message: "taken" }
      files.set(path, { bytes: new Uint8Array(content), url: write.url ?? null })
      return { ok: true, file: entry(path) }
    },
  }
  return { member, files }
}

test("each finished download is saved to My files once, with the page it came from, never over an existing file", async () => {
  const folder = downloadsFolder()
  const mine = myFiles()
  mine.files.set("Downloads/statement.pdf", { bytes: bytes("from another chat"), url: null })
  folder.download("statement.pdf", "%PDF this one", "https://bank.example.test/s/10")
  folder.download("receipts/train.pdf", "%PDF train")
  const first = await collectDownloads(folder.vm, mine.member)
  assert.deepEqual(first.saved, ["Downloads/statement (2).pdf", "Downloads/receipts/train.pdf"])
  assert.equal(mine.files.get("Downloads/statement (2).pdf")?.url, "https://bank.example.test/s/10")
  assert.equal(Buffer.from(mine.files.get("Downloads/statement.pdf")?.bytes ?? []).toString(), "from another chat")
  assert.deepEqual(await collectDownloads(folder.vm, mine.member), { saved: [], notSaved: [] }, "nothing new, nothing saved")
  assert.deepEqual(downloadNotes(first), ["[Saved to My files: /files/Downloads/statement (2).pdf, /files/Downloads/receipts/train.pdf]"])
})

test("a background run's downloads go to its agent folder; one that can't save, or a file too big, is said once", async () => {
  const folder = downloadsFolder()
  const agent = myFiles({ downloads: "agents/workbot/Downloads", maxFileBytes: 8 })
  folder.download("small.txt", "tiny")
  folder.download("movie.mp4", "x".repeat(9))
  const report = await collectDownloads(folder.vm, agent.member)
  assert.deepEqual(report.saved, ["agents/workbot/Downloads/small.txt"])
  assert.deepEqual(report.notSaved, ["/files/Downloads/movie.mp4 (9 bytes; the most a file in My files can be is 8 bytes)"])
  assert.deepEqual((await collectDownloads(folder.vm, agent.member)).notSaved, [])
  const readOnly = downloadsFolder()
  readOnly.download("a.txt", "a")
  assert.deepEqual((await collectDownloads(readOnly.vm, myFiles({ downloads: null }).member)).notSaved, ["/files/Downloads/a.txt (this run can't save files)"])
})

test("names: numbered copies keep folders and extensions, and an upload's copy keeps the file's name", () => {
  assert.equal(numbered("Downloads", "a/b.tar.gz", 1), "Downloads/a/b.tar.gz")
  assert.equal(numbered("Downloads", "a/b.tar.gz", 3), "Downloads/a/b.tar (3).gz")
  assert.equal(numbered("Downloads", "README", 2), "Downloads/README (2)")
  assert.match(uploadPath("Reports/q3 review.pdf", 4), /^\/files\/\.uploads\/[a-f0-9]{16}\/q3 review\.pdf$/)
  assert.notEqual(uploadPath("Reports/q3.pdf", 4), uploadPath("Reports/q3.pdf", 5), "a new version gets its own copy")
})

test("the computer's scan lists finished downloads only: not partial, hidden or lock files, nor links", () => {
  const root = mkdtempSync(join(tmpdir(), "member-downloads-scan-"))
  try {
    mkdirSync(join(root, ".cache"))
    writeFileSync(join(root, "report.pdf"), "%PDF")
    writeFileSync(join(root, "movie.mp4.crdownload"), "partial")
    writeFileSync(join(root, ".hidden"), "x")
    writeFileSync(join(root, ".cache", "x.txt"), "x")
    writeFileSync(join(root, "~$draft.docx"), "lock")
    symlinkSync("/etc/hosts", join(root, "hosts"))
    const scanned = parseScan(`${execFileSync("python3", ["-c", SCAN_SCRIPT, root]).toString()}---member-downloads---\n{"report.pdf":"4:1"}`)
    assert.deepEqual(scanned.files.map((file) => [file.path, file.size]), [["report.pdf", 4]])
    assert.match(scanned.files[0]?.sig ?? "", /^4:\d+$/)
    assert.deepEqual(scanned.manifest, { "report.pdf": "4:1" })
    assert.deepEqual(parseScan("python3: not found").files, [], "an image without python reads as no downloads")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
