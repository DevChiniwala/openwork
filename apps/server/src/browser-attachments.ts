import { basename, isAbsolute, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { ServerConfig } from "./types.js";
import { ApiError } from "./errors.js";
import { allowedRoots, isWithinRoot, mimeTypeForPath } from "./extensions/cloud-uploads.js";
import { openWorkspaceFileForReading } from "./workspace-file-identity.js";

export const BROWSER_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;
export const browserAttachmentRequest = z.object({ paths: z.array(z.string().min(1).max(4096)).min(1).max(10), directory: z.string().min(1).max(4096).optional() }).strict();

/** Read from verified handles, never pass local paths or filesystem authority to a page. */
export async function readBrowserAttachments(config: ServerConfig, paths: string[], signal: AbortSignal, directory?: string) {
  const roots = allowedRoots(config);
  const files: { name: string; bytesBase64: string; mimeType: string }[] = [];
  let total = 0;
  for (const requested of paths) {
    signal.throwIfAborted();
    let found = false;
    if (!isAbsolute(requested) && !directory && roots.length !== 1) {
      throw new ApiError(400, "ambiguous_workspace", "Use an absolute attachment path: the requesting workspace is ambiguous.");
    }
    const candidate = isAbsolute(requested) ? resolve(requested) : resolve(directory ?? roots[0] ?? "", requested);
    if (directory && !isAbsolute(requested) && !roots.some(root => isWithinRoot(resolve(directory), root))) {
      throw new ApiError(403, "forbidden", "The requesting workspace is outside authorized roots.");
    }
    for (const root of roots) {
      if (!isWithinRoot(candidate, root)) continue;
      const realRoot = await realpath(root).catch(() => null);
      if (!realRoot) continue;
      // Canonicalize the trusted root only, not the requested path: links within it are refused.
      const path = resolve(realRoot, relative(root, candidate));
      const opened = await openWorkspaceFileForReading(realRoot, path, "Browser attachment").catch(error => {
        if (error instanceof Error && "code" in error && error.code === "missing") return null;
        throw error;
      });
      if (!opened) continue;
      try {
        if (opened.info.size > BROWSER_ATTACHMENT_MAX_BYTES - total) {
          throw new ApiError(413, "file_too_large", "Browser attachments support at most 32 MiB in total.");
        }
        // Bound the read even if another process grows the file after stat.
        const bytes = Buffer.alloc(opened.info.size);
        let offset = 0;
        while (offset < bytes.length) {
          signal.throwIfAborted();
          const read = await opened.handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) throw new ApiError(409, "file_changed", "The attachment changed while it was read.");
          offset += read.bytesRead;
        }
        const after = await opened.handle.stat();
        if (after.size !== opened.info.size || after.mtimeMs !== opened.info.mtimeMs || after.ctimeMs !== opened.info.ctimeMs) {
          throw new ApiError(409, "file_changed", "The attachment changed while it was read.");
        }
        signal.throwIfAborted();
        total += bytes.length;
        files.push({ name: basename(requested), bytesBase64: bytes.toString("base64"), mimeType: mimeTypeForPath(requested) });
        found = true;
      } finally {
        await opened.handle.close();
      }
      break;
    }
    if (!found) throw new ApiError(404, "file_not_found", "Attachment was not found inside an authorized workspace root.");
  }
  return { files };
}
