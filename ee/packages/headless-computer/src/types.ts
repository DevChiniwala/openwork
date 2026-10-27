/**
 * What the computer needs from the runner that hosts it, as plain shapes: the runner's own types match them, so
 * neither package imports the other.
 */

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> }
export type ToolImage = { mediaType: string; data: string }
export type ToolDocument = { mediaType: "application/pdf"; data: string; name: string }
export type ToolResult = { output: string; isError: boolean; images?: ToolImage[]; documents?: ToolDocument[] }

/** A file kept for the person (an upload, or something the agent handed back). */
export type ComputerFile = { id: string; name: string; size: number; source: "user" | "agent"; updatedAt: number }

/** The conversation's kept files: uploads are copied in, files in /workspace/out are handed back. */
export interface ComputerFiles {
  /** The largest file the conversation may keep; bigger outputs are left on the computer. */
  readonly maxFileBytes: number
  /** Newest first. */
  list(sessionId: string): ComputerFile[]
  read(sessionId: string, id: string): Promise<{ file: ComputerFile; bytes: Uint8Array<ArrayBuffer> } | null>
  /** Throws, with a message for the model, when the file doesn't fit the conversation's limits. */
  add(sessionId: string, input: { name: string; bytes: Uint8Array<ArrayBuffer>; source: "agent" }): Promise<ComputerFile>
  /** A new version of a file already handed back (same id); null when it no longer exists. Throws like `add`. */
  replace(sessionId: string, id: string, input: { bytes: Uint8Array<ArrayBuffer> }): Promise<ComputerFile | null>
  /** Page images of a slide deck, document or PDF, for previews. */
  putPreview(sessionId: string, id: string, pages: Array<Uint8Array<ArrayBuffer>>, size: { width: number; height: number }): Promise<boolean>
}

/** A file in the member's My files, as the browser's downloads and uploads need it. `path` is inside My files. */
export type MemberFileEntry = { path: string; size: number; version: number; updatedAt: number }
export type MemberFileWrite = { ok: true; file: MemberFileEntry } | { ok: false; code: string; message: string }

/**
 * One browser call's view of the member's My files. The runner binds it to the conversation's owner and to what this
 * run may change; the computer never names a space or sees a store key.
 */
export interface ComputerMemberFiles {
  /** The largest file My files keeps; bigger downloads stay on the computer and are reported. */
  readonly maxFileBytes: number
  /** Where this run's downloads are saved: Downloads, or a background run's agent folder; null when it can't save. */
  readonly downloads: string | null
  read(path: string): Promise<{ file: MemberFileEntry; bytes: Uint8Array<ArrayBuffer> } | null>
  /** `ifVersion` null: only when the path is free (else `conflict`). */
  write(path: string, bytes: Uint8Array<ArrayBuffer>, input: { kind: "browser"; ifVersion: null; url?: string | null }): Promise<MemberFileWrite>
}

/**
 * The person's approvals for uploading files from My files to a site. A page can prompt-inject the agent, so nothing is
 * uploaded until the person approved those files for that site; the computer only reads approvals and asks for them.
 */
export interface UploadApprovals {
  /** Sites (`host`) the person approved for all of these `/files` paths at these versions, while the approval holds. */
  approvedHosts(files: Array<{ path: string; version: number }>): Promise<string[]>
  /** Asks the person (through the caller) to approve these files, at these versions, for this site; returns the ask's id. */
  request(files: Array<{ path: string; version: number }>, host: string): Promise<string>
}

/** What one desktop call may use beyond the conversation; null My files turns the browser's Downloads back. */
export type ComputerCallContext = { memberFiles: ComputerMemberFiles | null; uploads?: UploadApprovals }

/**
 * Turns a file into what the model can see: an image or PDF as model input, text as text, or a note. `counts`
 * caps images and PDFs per result across the files of one call.
 */
export type FileReader = (
  file: { name: string; bytes: Uint8Array },
  counts: { images: number; documents: number },
) => Promise<{ text: string; image?: ToolImage; document?: ToolDocument }>
