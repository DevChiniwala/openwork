import { z } from "zod"
import { readPart } from "./files.js"
import { memberPathOf, namesMemberFiles, shownPath, type MemberFile, type MemberFilesAccess } from "./member-files.js"
import { formatBytes, readToolFile } from "./tool-files.js"
import type { ToolResult, ToolSpec } from "./types.js"

/**
 * The scratch file tools in a conversation with My files: the same names, also taking `/files/...` paths. A
 * conversation without My files keeps the plain tools (files.ts), so its tools and prompt don't change.
 */
export const MEMBER_FILE_TOOLS: ToolSpec[] = [
  {
    name: "list_files",
    description:
      "List files. Without `path`: your scratch workspace for this conversation, and what is at the top of /files (the person's My files). With a folder such as /files or /files/Downloads: everything in it.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "read_file",
    description:
      "Read a file from the scratch workspace or from /files. Text is shown as text: for part of a long file, give `start` (first line) and `lines`, or `find` to get the numbered lines that contain some text. Images and PDFs are shown as they are; Word, Excel and PowerPoint files as their text.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, start: { type: "integer", minimum: 1 }, lines: { type: "integer", minimum: 1 }, find: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a text file: in the scratch workspace for drafts and notes, or under /files to keep it in the person's My files (for example /files/agents/workbot/plan.md).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description: "Replace the first exact occurrence of `find` with `replace` in a text file, in the scratch workspace or under /files.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
      required: ["path", "find", "replace"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    description: "Delete a file from the scratch workspace or from /files.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
]

const fail = (output: string): ToolResult => ({ output, isError: true })

/** Files up to this size are read as text when they decode as text. */
const MAX_TEXT_BYTES = 8 * 1024 * 1024
/** Lines a listing shows before it says how many more there are. */
const MAX_LISTED = 200
const TEXT_TYPE = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|x-ndjson|sql|toml|x-sh))/

/** The file's text, or null when it isn't text (or too big to read as text). */
export function memberText(file: { mediaType: string }, bytes: Uint8Array<ArrayBuffer>): string | null {
  if (bytes.byteLength > MAX_TEXT_BYTES) return null
  if (!TEXT_TYPE.test(file.mediaType) && file.mediaType !== "application/octet-stream") return null
  if (bytes.subarray(0, 8192).includes(0)) return null
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return null
  }
}

/** Where a file came from, in a few words for the model. */
export function originNote(file: MemberFile) {
  const { origin } = file
  if (origin.kind === "browser") {
    let host = ""
    try {
      host = origin.url ? new URL(origin.url).host : ""
    } catch {
      host = ""
    }
    return host ? `downloaded in the browser from ${host}` : "downloaded in the browser"
  }
  if (origin.kind === "upload") return "added by the person"
  return origin.agent ? `made by ${origin.agent}` : "made by an agent"
}

const dateOf = (at: number) => new Date(at).toISOString().slice(0, 10)
const line = (file: MemberFile) => `${shownPath(file.path)}\t${formatBytes(file.size)}\t${originNote(file)}, ${dateOf(file.updatedAt)}`

/** The top of My files: its folders with how many files each holds, and its loose files. */
async function topOfMemberFiles(access: MemberFilesAccess) {
  const files = await access.list()
  if (files.length === 0) return `${shownPath("")} (the person's My files) is empty.`
  const folders = new Map<string, { count: number; bytes: number }>()
  const loose: MemberFile[] = []
  for (const file of files) {
    const slash = file.path.indexOf("/")
    if (slash < 0) {
      loose.push(file)
      continue
    }
    const folder = file.path.slice(0, slash)
    const entry = folders.get(folder) ?? { count: 0, bytes: 0 }
    entry.count += 1
    entry.bytes += file.size
    folders.set(folder, entry)
  }
  const total = files.reduce((sum, file) => sum + file.size, 0)
  const lines = [
    ...[...folders].map(([folder, entry]) => `${shownPath(folder)}/\t${entry.count} ${entry.count === 1 ? "file" : "files"}, ${formatBytes(entry.bytes)}`),
    ...loose.map(line),
  ]
  const shown = lines.slice(0, MAX_LISTED)
  return [`${shownPath("")} (the person's My files, ${files.length} ${files.length === 1 ? "file" : "files"}, ${formatBytes(total)}):`, ...shown, ...(lines.length > shown.length ? [`…and ${lines.length - shown.length} more`] : [])].join("\n")
}

const pathInput = z.object({ path: z.string() })
const listInput = z.object({ path: z.string().optional() })
const readInput = z.object({ path: z.string(), start: z.number().int().min(1).optional(), lines: z.number().int().min(1).optional(), find: z.string().min(1).optional() })
const writeInput = z.object({ path: z.string(), content: z.string() })
const editInput = z.object({ path: z.string(), find: z.string().min(1), replace: z.string() })

/** The /files path a writing call targets, or null when it targets the scratch workspace (or isn't a writing call). */
export function memberWriteTarget(name: string, input: unknown): string | null {
  if (name !== "write_file" && name !== "edit_file" && name !== "delete_file") return null
  const parsed = pathInput.safeParse(input)
  return parsed.success && namesMemberFiles(parsed.data.path) ? memberPathOf(parsed.data.path) ?? "" : null
}

/** Whether a call names /files at all (valid or not): such a call never falls through to the scratch workspace. */
export function targetsMemberFiles(name: string, input: unknown) {
  if (name === "list_files") {
    const parsed = listInput.safeParse(input)
    return parsed.success && parsed.data.path !== undefined && namesMemberFiles(parsed.data.path)
  }
  const parsed = pathInput.safeParse(input)
  return parsed.success && namesMemberFiles(parsed.data.path)
}

/** The top of /files, shown under the scratch workspace when list_files has no path. */
export function listMemberTop(access: MemberFilesAccess) {
  return topOfMemberFiles(access)
}

/** A file tool call on a /files path (see targetsMemberFiles). */
export async function runMemberFileTool(access: MemberFilesAccess, name: string, input: unknown): Promise<ToolResult> {
  if (name === "list_files") {
    const parsed = listInput.safeParse(input)
    const folder = parsed.success && parsed.data.path !== undefined ? memberPathOf(parsed.data.path) : null
    if (folder === null) return fail("That isn't a folder in /files.")
    if (folder === "") return { output: await topOfMemberFiles(access), isError: false }
    const files = await access.list({ prefix: folder })
    if (files.length === 0) return { output: `Nothing is in ${shownPath(folder)}.`, isError: false }
    const shown = files.slice(0, MAX_LISTED).map(line)
    return { output: [...shown, ...(files.length > shown.length ? [`…and ${files.length - shown.length} more; list a folder inside it to see them`] : [])].join("\n"), isError: false }
  }
  const target = pathInput.safeParse(input)
  const path = target.success ? memberPathOf(target.data.path) : null
  if (path === null || path === "") return fail(`That isn't a file in /files. Names can't contain "..", control characters or names over 255 characters.`)
  if (name === "read_file") {
    const part = readInput.safeParse(input)
    if (!part.success) return fail("read_file needs a string `path`; `start` and `lines` are whole numbers from 1.")
    const found = await access.read(path)
    if (!found) return fail(`There is no file at ${shownPath(path)}. Use list_files with path "/files" to see what is there.`)
    const text = memberText(found.file, found.bytes)
    if (text !== null) return { output: readPart(text, part.data), isError: false }
    const reading = await readToolFile({ name: found.file.name, mimeType: found.file.mediaType, data: Buffer.from(found.bytes).toString("base64") }, { images: 0, documents: 0 })
    return {
      output: `${shownPath(path)} (${formatBytes(found.file.size)}, ${originNote(found.file)})\n${reading.text}`,
      isError: false,
      ...(reading.image ? { images: [reading.image] } : {}),
      ...(reading.document ? { documents: [reading.document] } : {}),
    }
  }
  if (name === "write_file") {
    const parsed = writeInput.safeParse(input)
    if (!parsed.success) return fail("write_file needs a string `path` and `content`.")
    const written = await access.write(path, new Uint8Array(Buffer.from(parsed.data.content, "utf8")), { kind: "agent" })
    return written.ok ? { output: `Saved ${shownPath(path)} (${formatBytes(written.file.size)}) in My files.`, isError: false } : fail(written.message)
  }
  if (name === "edit_file") {
    const parsed = editInput.safeParse(input)
    if (!parsed.success) return fail("edit_file needs string `path`, `find` and `replace`.")
    if (!access.canWrite(path)) return fail(access.refusal(path))
    const found = await access.read(path)
    if (!found) return fail(`There is no file at ${shownPath(path)}.`)
    const text = memberText(found.file, found.bytes)
    if (text === null) return fail(`${shownPath(path)} isn't a text file, so it can't be edited this way.`)
    const index = text.indexOf(parsed.data.find)
    if (index < 0) return fail("`find` text was not found in the file.")
    const next = text.slice(0, index) + parsed.data.replace + text.slice(index + parsed.data.find.length)
    // Only over the version just read: an edit never undoes someone else's change.
    const written = await access.write(path, new Uint8Array(Buffer.from(next, "utf8")), { kind: "agent", ifVersion: found.file.version, mediaType: found.file.mediaType })
    return written.ok ? { output: `Saved ${shownPath(path)} (${formatBytes(written.file.size)}) in My files.`, isError: false } : fail(written.message)
  }
  if (name === "delete_file") {
    const deleted = await access.delete(path)
    if (deleted.ok) return { output: `Deleted ${shownPath(path)} from My files.`, isError: false }
    if (deleted.code === "not_found" && (await access.list({ prefix: path })).length > 0) return fail(`${shownPath(path)} is a folder; delete its files one by one.`)
    return fail(deleted.message)
  }
  return fail(`Unknown file tool: ${name}`)
}

/** What the model is told about My files, for this run's access. */
export function memberFilesPrompt(input: { agent: string | null; writeRoot: string | null | false; browser: boolean }) {
  const agentFolder = input.agent ? `/files/agents/${input.agent}/` : null
  return [
    `- The person's own files ("My files") are in /files, kept across all their conversations. Find them with list_files (path "/files") and read them with read_file. Save what they should keep under /files with write_file${agentFolder ? `; your own notes and working files go in ${agentFolder}` : ""}.`,
    input.browser
      ? "- Files you download in the browser are saved to My files in /files/Downloads. To upload one of their files to a website, use the browser act action {type:\"upload\",ref,paths:[\"/files/...\"]} on the control that opens the site's file chooser."
      : "",
    "- When you create or change a file in /files, link it in your reply like [report.pdf](/files/Downloads/report.pdf) so they can open it.",
    input.writeRoot === false
      ? "- In this run you can read /files but not change it."
      : typeof input.writeRoot === "string"
        ? `- In this run you can read all of /files but only save in /files/${input.writeRoot}/.`
        : "",
  ]
    .filter(Boolean)
    .join("\n")
}
