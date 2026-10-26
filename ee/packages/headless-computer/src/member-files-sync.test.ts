import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { copyName, parseScan, PATHS_SCRIPT, SCAN_SCRIPT, syncMemberFiles, syncNotes, type Manifest, type MirrorVm } from "./member-files-sync.js"
import type { ComputerMemberFiles, MemberFileEntry } from "./types.js"

const bytes = (text: string) => new Uint8Array(Buffer.from(text))
const text = (value: Uint8Array | undefined) => Buffer.from(value ?? []).toString()

/** /files on a computer, in memory: every write moves the clock, so a signature changes with each version. */
function computer() {
  let clock = 1
  const files = new Map<string, { bytes: Uint8Array<ArrayBuffer>; mtime: number; url?: string }>()
  let manifest: unknown = {}
  const vm: MirrorVm = {
    async scan() {
      return { files: [...files].map(([path, file]) => ({ path, size: file.bytes.byteLength, sig: `${file.bytes.byteLength}:${file.mtime}`, url: file.url ?? null })), manifest }
    },
    async read(path) {
      const file = files.get(path)
      if (!file) throw new Error(`no ${path}`)
      return new Uint8Array(file.bytes)
    },
    async folders() {},
    async write(path, content) {
      files.set(path, { bytes: new Uint8Array(content), mtime: clock++ })
    },
    async signatures(paths) {
      return new Map(paths.flatMap((path) => {
        const file = files.get(path)
        return file ? [[path, `${file.bytes.byteLength}:${file.mtime}`]] : []
      }))
    },
    async remove(paths) {
      for (const path of paths) files.delete(path)
    },
    async saveManifest(next: Manifest) {
      manifest = JSON.parse(JSON.stringify(next))
    },
  }
  /** What a command or the browser does on the computer. */
  const save = (path: string, content: string, url?: string) => files.set(path, { bytes: bytes(content), mtime: clock++, ...(url ? { url } : {}) })
  return { vm, files, save, read: (path: string) => text(files.get(path)?.bytes) }
}

/** The member's My files, in memory, as one run sees them (`writeRoot`: where it may save; null anywhere). */
function myFiles(input: { writeRoot?: string | null; maxFileBytes?: number } = {}) {
  let clock = 1_000
  const files = new Map<string, { bytes: Uint8Array<ArrayBuffer>; version: number; updatedAt: number; kind: string; url: string | null }>()
  const entry = (path: string): MemberFileEntry | null => {
    const file = files.get(path)
    return file ? { path, size: file.bytes.byteLength, version: file.version, updatedAt: file.updatedAt } : null
  }
  const root = input.writeRoot ?? null
  const member: ComputerMemberFiles = {
    maxFileBytes: input.maxFileBytes ?? 1024,
    async list() {
      return [...files.keys()].flatMap((path) => entry(path) ?? [])
    },
    async read(path) {
      const found = entry(path)
      const file = files.get(path)
      return found && file ? { file: found, bytes: new Uint8Array(file.bytes) } : null
    },
    async write(path, content, write) {
      const current = files.get(path)
      if (write.ifVersion === null ? current !== undefined : current?.version !== write.ifVersion) return { ok: false, code: "conflict", message: "changed" }
      files.set(path, { bytes: new Uint8Array(content), version: (current?.version ?? 0) + 1, updatedAt: clock++, kind: write.kind, url: write.url ?? null })
      const saved = entry(path)
      return saved ? { ok: true, file: saved } : { ok: false, code: "not_found", message: "gone" }
    },
    async delete(path, ifVersion) {
      const current = files.get(path)
      if (!current) return { ok: false, code: "not_found", message: "none" }
      if (ifVersion !== undefined && current.version !== ifVersion) return { ok: false, code: "conflict", message: "changed" }
      files.delete(path)
      return { ok: true }
    },
    canWrite: (path) => root === null || path === root || path.startsWith(`${root}/`),
    refusal: (path) => `This run can only save in /files/${root}/, so /files/${path} was not changed.`,
  }
  /** What another chat (or the person) does in My files meanwhile. */
  const put = (path: string, content: string) => {
    const current = files.get(path)
    files.set(path, { bytes: bytes(content), version: (current?.version ?? 0) + 1, updatedAt: clock++, kind: "agent", url: null })
  }
  return { member, files, put, read: (path: string) => text(files.get(path)?.bytes) }
}

test("My files arrive on the computer, and a second sync with nothing new does nothing", async () => {
  const vm = computer()
  const mine = myFiles()
  mine.put("Plans/q4.md", "ship it")
  mine.put("Downloads/invoice.pdf", "%PDF")
  const first = await syncMemberFiles(vm.vm, mine.member, "computer")
  assert.equal(first.pulled, 2)
  assert.equal(vm.read("Plans/q4.md"), "ship it")
  const second = await syncMemberFiles(vm.vm, mine.member, "computer")
  assert.deepEqual([second.pulled, second.saved, second.deleted, second.copies], [0, [], [], []])
  assert.equal(second.stamp, first.stamp)
  assert.deepEqual(syncNotes(second), [])
})

test("what the computer and the browser make or change is saved to My files, attributed and with its address", async () => {
  const vm = computer()
  const mine = myFiles()
  await syncMemberFiles(vm.vm, mine.member, "computer")
  vm.save("Downloads/statement.pdf", "%PDF-1", "https://bank.example.test/s/1")
  const browser = await syncMemberFiles(vm.vm, mine.member, "browser")
  assert.deepEqual(browser.saved, ["Downloads/statement.pdf"])
  assert.equal(mine.files.get("Downloads/statement.pdf")?.kind, "browser")
  assert.equal(mine.files.get("Downloads/statement.pdf")?.url, "https://bank.example.test/s/1")
  vm.save("Downloads/statement.pdf", "%PDF-2")
  const edited = await syncMemberFiles(vm.vm, mine.member, "computer")
  assert.deepEqual(edited.saved, ["Downloads/statement.pdf"])
  assert.equal(mine.files.get("Downloads/statement.pdf")?.version, 2)
  assert.match(syncNotes(edited)[0] ?? "", /\[Saved to My files: \/files\/Downloads\/statement\.pdf\]/)
})

test("changed on both sides: My files keeps the name and the computer's version is kept beside it", async () => {
  const vm = computer()
  const mine = myFiles()
  mine.put("report.docx", "v1")
  await syncMemberFiles(vm.vm, mine.member, "computer")
  mine.put("report.docx", "v2 from another chat")
  vm.save("report.docx", "v2 from this computer")
  const report = await syncMemberFiles(vm.vm, mine.member, "computer")
  assert.deepEqual(report.copies, [{ path: "report.docx", copy: "report (computer copy).docx" }])
  assert.equal(mine.read("report.docx"), "v2 from another chat")
  assert.equal(mine.read("report (computer copy).docx"), "v2 from this computer")
  assert.equal(vm.read("report.docx"), "v2 from another chat")
  assert.equal(vm.read("report (computer copy).docx"), "v2 from this computer")
  assert.match(syncNotes(report).join("\n"), /Kept both: \/files\/report\.docx changed in My files too, so this computer's version was saved as \/files\/report \(computer copy\)\.docx/)
  // Settled: nothing more to do.
  const settled = await syncMemberFiles(vm.vm, mine.member, "computer")
  assert.deepEqual([settled.saved, settled.copies, settled.pulled], [[], [], 0])
  assert.equal(copyName("a/b.tar.gz", (path) => path === "a/b.tar (computer copy).gz"), "a/b.tar (computer copy 2).gz")
})

test("deletes go both ways, and an edit always beats a delete", async () => {
  const vm = computer()
  const mine = myFiles()
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) mine.put(name, name)
  await syncMemberFiles(vm.vm, mine.member, "computer")
  vm.files.delete("a.txt") // deleted on the computer
  mine.files.delete("b.txt") // deleted in My files
  vm.files.delete("c.txt") // deleted on the computer…
  mine.put("c.txt", "c edited elsewhere") // …but edited in My files
  mine.files.delete("d.txt") // deleted in My files…
  vm.save("d.txt", "d edited here") // …but edited on the computer
  const report = await syncMemberFiles(vm.vm, mine.member, "computer")
  assert.deepEqual(report.deleted, ["a.txt"])
  assert.equal(mine.files.has("a.txt"), false)
  assert.equal(vm.files.has("b.txt"), false)
  assert.equal(vm.read("c.txt"), "c edited elsewhere")
  assert.equal(mine.read("d.txt"), "d edited here")
})

test("a background run's changes outside its agent folder stay on the computer and are said once; its deletes are put back", async () => {
  const vm = computer()
  const mine = myFiles({ writeRoot: "agents/workbot" })
  mine.put("keep.md", "theirs")
  await syncMemberFiles(vm.vm, mine.member, "computer")
  vm.save("agents/workbot/notes.md", "mine")
  vm.save("summary.md", "outside")
  vm.files.delete("keep.md")
  const report = await syncMemberFiles(vm.vm, mine.member, "computer")
  assert.deepEqual(report.saved, ["agents/workbot/notes.md"])
  assert.equal(mine.files.has("summary.md"), false)
  assert.equal(vm.read("keep.md"), "theirs", "a delete it may not make is put back")
  assert.match(syncNotes(report).join("\n"), /Not saved to My files: \/files\/keep\.md \(put back: This run can only save in \/files\/agents\/workbot\/.*\/files\/summary\.md \(This run can only save in/)
  const again = await syncMemberFiles(vm.vm, mine.member, "computer")
  assert.deepEqual(again.notSaved, [], "reported once, not after every command")
  assert.equal(vm.read("summary.md"), "outside", "and left on the computer")
})

test("files over the limit stay on the computer; a computer holds at most its share of My files, newest first", async () => {
  const vm = computer()
  const mine = myFiles({ maxFileBytes: 8 })
  vm.save("movie.mov", "x".repeat(9))
  const big = await syncMemberFiles(vm.vm, mine.member, "computer")
  assert.match(big.notSaved[0] ?? "", /\/files\/movie\.mov \(9 bytes; the most a file in My files can be is 8 bytes\)/)
  mine.put("old.txt", "12345")
  mine.put("new.txt", "67890")
  const fresh = computer()
  const report = await syncMemberFiles(fresh.vm, mine.member, "computer", { maxPullBytes: 6 })
  assert.equal(fresh.read("new.txt"), "67890")
  assert.equal(fresh.files.has("old.txt"), false)
  assert.deepEqual(report.notCopied, { count: 1, bytes: 5 })
  assert.match(syncNotes(report).join("\n"), /1 of their files \(5 bytes\) are in My files but not on this computer/)
})

test("the same file made on both sides with no history is one file, not a copy", async () => {
  const vm = computer()
  const mine = myFiles()
  mine.put("same.txt", "identical")
  vm.save("same.txt", "identical")
  vm.save("different.txt", "here")
  mine.put("different.txt", "there")
  const report = await syncMemberFiles(vm.vm, mine.member, "computer")
  assert.deepEqual(report.copies, [{ path: "different.txt", copy: "different (computer copy).txt" }])
  assert.equal([...mine.files.keys()].filter((path) => path.startsWith("same")).length, 1)
})

test("the computer's scan skips files still downloading, hidden files, lock files and links, and its path script stays inside /files", () => {
  const root = mkdtempSync(join(tmpdir(), "member-files-scan-"))
  try {
    mkdirSync(join(root, "Downloads"))
    mkdirSync(join(root, ".cache"))
    writeFileSync(join(root, "Downloads", "report.pdf"), "%PDF")
    writeFileSync(join(root, "Downloads", "movie.mp4.crdownload"), "partial")
    writeFileSync(join(root, ".hidden"), "x")
    writeFileSync(join(root, ".cache", "x.txt"), "x")
    writeFileSync(join(root, "~$draft.docx"), "lock")
    symlinkSync("/etc/hosts", join(root, "hosts"))
    const scanned = parseScan(`${execFileSync("python3", ["-c", SCAN_SCRIPT, root]).toString()}---member-files-manifest---\n{"a":{"v":1,"s":"1:1"}}`)
    assert.deepEqual(scanned.files.map((file) => [file.path, file.size]), [["Downloads/report.pdf", 4]])
    assert.match(scanned.files[0]?.sig ?? "", /^4:\d+$/)
    assert.deepEqual(scanned.manifest, { a: { v: 1, s: "1:1" } })
    execFileSync("python3", ["-c", PATHS_SCRIPT, root, "remove"], { env: { ...process.env, MEMBER_PATHS: JSON.stringify(["../outside", "hosts", "Downloads/report.pdf"]) } })
    assert.deepEqual(parseScan(`${execFileSync("python3", ["-c", SCAN_SCRIPT, root]).toString()}`).files, [])
    assert.equal(execFileSync("python3", ["-c", "import os,sys; print(os.path.islink(sys.argv[1]))", join(root, "hosts")]).toString().trim(), "True", "a link is never followed or removed")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
