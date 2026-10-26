/**
 * Single entry point for embedding the OpenWork server in-process.
 *
 * Handles config resolution and server start in one call -- mirrors what
 * cli.ts does but returns a handle instead of owning the process lifecycle.
 * The server runs its own OpenCode v2 engine; there is no other engine to
 * spawn.
 */
import { stopTaskRecovery } from "./task-recovery.js";
import { resolveServerConfig, type CliArgs } from "./config.js";
import { startServer } from "./server.js";
import { ensureLocalWorkspaceFiles } from "./workspace-init.js";
import { migrateOpenworkCloudMcpRuntimeConfig } from "./cloud-mcp-health.js";
import { migrateWorkspaceRuntimeConfigToEngineGlobal } from "./runtime-opencode-config-store.js";
import type { LocalManagedMcpVaultKeyProvider, ServerConfig } from "./types.js";

export type EmbeddedServerOptions = CliArgs & {
  /** Secure key custody for the local managed MCP credential vault. */
  localManagedMcpVaultKey?: LocalManagedMcpVaultKeyProvider;
  driveFileApproval?: ServerConfig["driveFileApproval"];
  resumeInterruptedTasks?: boolean;
  anonymousInference?: ServerConfig["anonymousInference"];
};

export type EmbeddedServerHandle = {
  /** Bound port the HTTP server is listening on. */
  port: number;
  /** Full base URL, e.g. http://127.0.0.1:48123 */
  url: string;
  /** The resolved server config. */
  config: ServerConfig;
  /** Stop the HTTP server and its engine. */
  stop: () => Promise<void>;
};

export async function startEmbeddedServer(options: EmbeddedServerOptions): Promise<EmbeddedServerHandle> {
  const config = await resolveServerConfig(options);
  config.localManagedMcpVaultKey = options.localManagedMcpVaultKey;
  config.driveFileApproval = options.driveFileApproval;
  config.anonymousInference = options.anonymousInference;
  config.resumeInterruptedTasks = options.resumeInterruptedTasks === true;

  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  let stopPromise: Promise<void> | null = null;

  const releaseResources = async (): Promise<void> => {
    const errors: unknown[] = [];
    try { await stopTaskRecovery(config); } catch (error) { errors.push(error); }
    const httpServer = server;
    server = null;
    if (httpServer) {
      try {
        await httpServer.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Failed to stop embedded OpenWork server");
    }
  };

  const stop = (): Promise<void> => {
    stopPromise ??= releaseResources();
    return stopPromise;
  };

  if (!config.readOnly) {
    await ensureLocalWorkspaceFiles(config.workspaces);
    await migrateOpenworkCloudMcpRuntimeConfig(config);
    await migrateWorkspaceRuntimeConfigToEngineGlobal(config);
  }

  try {
    server = await startServer(config);
  } catch (startupError) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "Embedded OpenWork server startup failed and cleanup was incomplete",
      );
    }
    throw startupError;
  }
  config.port = server.port;

  return {
    port: server.port,
    url: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.port}`,
    config,
    stop,
  };
}
