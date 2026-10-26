export { Computers, canPreview, type ComputerOptions } from "./computer.js"
export { DesktopError } from "./desktop.js"
export { COMPUTER_INSTALL_SCRIPT, computerSnapshotSlug } from "./image.js"
export type { ComputerFile, ComputerFiles, FileReader, ToolResult, ToolSpec } from "./types.js"

export { createComputerProvider, type ComputerProviderConfig } from "./providers.js"
export type { ComputerCallContext, ComputerMemberFiles, MemberFileEntry } from "./types.js"
export { syncMemberFiles, syncNotes, MEMBER_FILES_DIR, type MirrorVm, type SyncReport } from "./member-files-sync.js"
