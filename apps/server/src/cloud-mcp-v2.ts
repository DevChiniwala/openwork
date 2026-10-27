import type { CloudMcpNativeEngineResolver, CloudMcpRuntimeRegistrar } from "./cloud-mcp-health.js";
import type { EngineV2Preview } from "./engine-v2-preview.js";
import artifacts from "./opencode-v2-artifacts.json" with { type: "json" };

/**
 * Bind each health request to the local OpenCode v2 engine. Returns undefined
 * while the engine is not running (starting, or copying history), which health
 * reports as a retryable not-ready state.
 */
export function createNativeCloudMcpResolver(preview: Pick<EngineV2Preview, "connection">): CloudMcpNativeEngineResolver {
  return () => {
    if (!preview.connection()) return undefined;
    return {
      version: artifacts.version,
      request: async (path, directory, method = "GET") => {
        const connection = preview.connection();
        if (!connection) throw new Error("OpenCode v2 is not running. Reconnect before checking OpenWork Connect.");
        const url = new URL(path, connection.url);
        if (directory) url.searchParams.set("location[directory]", directory);
        const response = await fetch(url, {
          method,
          headers: { Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}` },
          signal: AbortSignal.timeout(method === "POST" ? 30_000 : 5_000),
        });
        if (!response.ok) throw new Error(`OpenCode v2 ${path} returned ${response.status}`);
        return response.status === 204 ? undefined : response.json();
      },
    };
  };
}

/** Register a folder's runtime MCP servers with OpenCode v2. */
export function createRoutedCloudMcpRegistrar(preview: Pick<EngineV2Preview, "syncWorkspaceMcp">): CloudMcpRuntimeRegistrar {
  return async (_config, workspace, onlyNames, options) => {
    const names = onlyNames ?? ["openwork-cloud"];
    try {
      // The folder's reconciler registers changed config and restarts only
      // connections that are not healthy (including one a repair
      // disconnected). A healthy connection is never restarted by a refresh.
      await preview.syncWorkspaceMcp(workspace.id, workspace.path, { reconnect: names });
      return { status: "ok", syncedNames: names, failures: [] };
    } catch (error) {
      if (options?.throwOnFailure) throw error;
      return { status: "failed", syncedNames: [], failures: [{ name: "openwork-cloud", message: error instanceof Error ? error.message : "OpenCode v2 MCP registration failed" }] };
    }
  };
}
