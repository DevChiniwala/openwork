import { z } from "zod"
import { MemoryUnavailableError, type MemoryAccess } from "./memory.js"
import type { Store } from "./store.js"
import type { ToolResult, ToolSpec } from "./types.js"

/**
 * A per-session scratch filesystem stored in SQLite. There is no host
 * filesystem, no shell, and no process execution behind these tools.
 */
export const FILE_LIMITS = {
  maxFileBytes: 1024 * 1024,
  maxSessionBytes: 10 * 1024 * 1024,
  maxFiles: 200,
  maxPathLength: 200,
}

export function normalizePath(input: string): string | null {
  const parts = input.replaceAll("\\", "/").split("/").filter((part) => part && part !== ".")
  if (parts.length === 0 || parts.some((part) => part === "..")) return null
  const path = parts.join("/")
  if (path.length > FILE_LIMITS.maxPathLength || /[\u0000-\u001f]/.test(path)) return null
  return path
}

const pathInput = z.object({ path: z.string() })
const writeInput = z.object({ path: z.string(), content: z.string() })
const editInput = z.object({ path: z.string(), find: z.string().min(1), replace: z.string() })

export const FILE_TOOLS: ToolSpec[] = [
  {
    name: "list_files",
    description: "List the files in this conversation's scratch workspace. Files persist across turns.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_file",
    description: "Read a text file from the scratch workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file in the scratch workspace (for drafts, notes, CSV, Markdown).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description: "Replace the first exact occurrence of `find` with `replace` in a scratch file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
      required: ["path", "find", "replace"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    description: "Delete a file from the scratch workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
]

export const FILE_TOOL_NAMES: ReadonlySet<string> = new Set(FILE_TOOLS.map((tool) => tool.name))

const fail = (output: string): ToolResult => ({ output, isError: true })

function checkedWrite(store: Store, sessionId: string, path: string, content: string): ToolResult {
  const size = Buffer.byteLength(content)
  if (size > FILE_LIMITS.maxFileBytes) return fail(`File is larger than ${FILE_LIMITS.maxFileBytes} bytes.`)
  const files = store.listFiles(sessionId)
  const existing = files.find((file) => file.path === path)
  if (!existing && files.length >= FILE_LIMITS.maxFiles) return fail(`Workspace already has ${FILE_LIMITS.maxFiles} files.`)
  const total = files.reduce((sum, file) => sum + file.size, 0) - (existing?.size ?? 0) + size
  if (total > FILE_LIMITS.maxSessionBytes) return fail(`Workspace would exceed ${FILE_LIMITS.maxSessionBytes} bytes.`)
  store.writeFile(sessionId, path, content)
  return { output: `Wrote ${path} (${size} bytes).`, isError: false }
}

/** The memory/ folder, which a conversation may share with others of the same person (see memory.ts). */
export const isMemoryPath = (path: string) => path === "memory" || path.startsWith("memory/")

/**
 * Runs a scratch file tool. With `memory`, paths under memory/ live there instead (another conversation's, or the
 * owner's), so the person's conversations remember together; everything else stays in this one. Without it, memory/
 * is this conversation's own, as every other path.
 */
export async function runFileTool(store: Store, sessionId: string, name: string, input: unknown, memory?: MemoryAccess | null): Promise<ToolResult> {
  const shared = (path: string) => (memory && isMemoryPath(path) ? memory : null)
  try {
    if (name === "list_files") {
      const files = memory
        ? [
            ...store.listFiles(sessionId).filter((file) => !isMemoryPath(file.path)),
            ...(await memory.list()).filter((file) => isMemoryPath(file.path)).map((file) => ({ path: file.path, size: Buffer.byteLength(file.content) })),
          ].sort((left, right) => left.path.localeCompare(right.path))
        : store.listFiles(sessionId)
      if (files.length === 0) return { output: "The workspace is empty.", isError: false }
      return { output: files.map((file) => `${file.path}\t${file.size} bytes`).join("\n"), isError: false }
    }
    const read = (path: string) => shared(path)?.read(path) ?? Promise.resolve(store.readFile(sessionId, path))
    const write = async (path: string, content: string): Promise<ToolResult> => {
      const target = shared(path)
      if (!target) return checkedWrite(store, sessionId, path, content)
      const written = await target.write(path, content)
      return written.ok ? { output: `Wrote ${path} (${written.size} bytes).`, isError: false } : fail(written.message)
    }
    if (name === "write_file") {
      const parsed = writeInput.safeParse(input)
      if (!parsed.success) return fail("write_file needs a string `path` and `content`.")
      const path = normalizePath(parsed.data.path)
      if (!path) return fail("Invalid path.")
      return await write(path, parsed.data.content)
    }
    if (name === "edit_file") {
      const parsed = editInput.safeParse(input)
      if (!parsed.success) return fail("edit_file needs string `path`, `find` and `replace`.")
      const path = normalizePath(parsed.data.path)
      const current = path ? await read(path) : null
      if (!path || current === null) return fail("File not found.")
      const index = current.indexOf(parsed.data.find)
      if (index < 0) return fail("`find` text was not found in the file.")
      const next = current.slice(0, index) + parsed.data.replace + current.slice(index + parsed.data.find.length)
      return await write(path, next)
    }
    const parsed = pathInput.safeParse(input)
    const path = parsed.success ? normalizePath(parsed.data.path) : null
    if (!path) return fail("Invalid path.")
    if (name === "read_file") {
      const content = await read(path)
      return content === null ? fail("File not found.") : { output: content, isError: false }
    }
    if (name === "delete_file") {
      const target = shared(path)
      const deleted = target ? await target.delete(path) : store.deleteFile(sessionId, path)
      return deleted ? { output: `Deleted ${path}.`, isError: false } : fail("File not found.")
    }
    return fail(`Unknown file tool: ${name}`)
  } catch (error) {
    // The owner's memory is in another cell that didn't answer: a write may or may not have reached it.
    if (error instanceof MemoryUnavailableError) return fail("Memory didn't respond, so this call's outcome is unknown. Read the file before repeating a change.")
    throw error
  }
}
