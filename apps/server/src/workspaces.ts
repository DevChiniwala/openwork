import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import type { WorkspaceConfig, WorkspaceInfo } from "./types.js";

function workspaceIdForKey(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `ws_${hash.slice(0, 12)}`;
}

export function workspaceIdForPath(path: string): string {
  return workspaceIdForKey(path);
}

export function buildWorkspaceInfos(
  workspaces: WorkspaceConfig[],
  cwd: string,
): WorkspaceInfo[] {
  return workspaces
    // Remote workspaces were removed; configs persisted by older builds can
    // still carry them, so drop any entry that is not a local workspace.
    .filter((workspace) => (workspace.workspaceType ?? "local") === "local")
    .map((workspace) => {
      const rawPath = workspace.path?.trim() ?? "";
      const resolvedPath = rawPath ? resolve(cwd, rawPath) : "";
      const id = workspace.id?.trim() || workspaceIdForPath(resolvedPath);
      const name = workspace.name?.trim()
        || workspace.displayName?.trim()
        || basename(resolvedPath || workspace.directory?.trim() || "Workspace");
      return {
        id,
        name,
        path: resolvedPath,
        preset: workspace.preset?.trim() || "starter",
        workspaceType: "local",
        baseUrl: workspace.baseUrl,
        directory: workspace.directory,
        displayName: workspace.displayName,
        sandboxBackend: workspace.sandboxBackend,
        sandboxRunId: workspace.sandboxRunId,
        sandboxContainerName: workspace.sandboxContainerName,
        opencodeUsername: workspace.opencodeUsername,
        opencodePassword: workspace.opencodePassword,
      };
    });
}

/**
 * Pick the workspace the server-managed OpenCode engine should boot in.
 *
 * The engine serves every workspace but needs one local directory to start in:
 * the first workspace with a resolved local path.
 */
export function findManagedEngineWorkspace(workspaces: WorkspaceInfo[]): WorkspaceInfo | undefined {
  return workspaces.find((workspace) => workspace.path.trim() !== "");
}

/**
 * Identity of the engine root the managed engine runs in when no workspace
 * scopes a request. It is not a registered workspace: it only names the
 * process cwd so engine-wide maintenance (reload, provider credentials) has a
 * target before the first workspace exists, exactly like `cd ~ && opencode`.
 */
export const MANAGED_ENGINE_ROOT_WORKSPACE_ID = "ws_managed_engine_root";

export function managedEngineRootWorkspace(cwd: string): WorkspaceInfo {
  return {
    id: MANAGED_ENGINE_ROOT_WORKSPACE_ID,
    name: "OpenCode engine",
    path: cwd,
    preset: "starter",
    workspaceType: "local",
  };
}
