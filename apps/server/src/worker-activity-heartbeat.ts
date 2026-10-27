import { cloudComputerActivityAt } from "./cloud-computer-activity.js";
import { externalFetch, loopbackFetch } from "./server-fetch.js";
import type { ServerConfig } from "./types.js";

const DEFAULT_ACTIVITY_WINDOW_MS = 5 * 60_000;
const DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS = 5 * 60_000;

export type WorkerActivityHeartbeatConfig = {
  enabled: boolean;
  workerId: string;
  url: string;
  token: string;
  intervalMs: number;
  activeWindowMs: number;
};

export type WorkerActivityHeartbeatHandle = {
  stop: () => void;
};

export type WorkerActivityHeartbeatLogger = {
  log: (level: "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>) => void;
};

export type WorkerActivityHeartbeatPayload = {
  sentAt: string;
  isActiveRecently: boolean;
  lastActivityAt: string | null;
  openSessionCount: number;
};

/** How to reach the running OpenCode v2 engine (Basic auth `username:password`). */
export type WorkerActivityEngineConnection = { url: string; username: string; password: string };

type HeartbeatEnv = Record<string, string | undefined>;
type HeartbeatFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function parsePositiveNumberEnv(value: string | undefined, fallback: number): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function parseSessionActivityAt(session: unknown): number | null {
  // OpenCode v2 list rows may wrap the session in `info`.
  const info = isRecord(session) && isRecord(session.info) ? session.info : session;
  if (!isRecord(info) || !isRecord(info.time)) return null;
  const updated = info.time.updated;
  if (typeof updated === "number" && Number.isFinite(updated) && updated > 0) return updated;
  const created = info.time.created;
  if (typeof created === "number" && Number.isFinite(created) && created > 0) return created;
  return null;
}

export function resolveWorkerActivityHeartbeatConfig(env: HeartbeatEnv = process.env): WorkerActivityHeartbeatConfig {
  const enabled = (env.DEN_ACTIVITY_HEARTBEAT_ENABLED ?? "").trim().toLowerCase();
  const provider = (env.DEN_RUNTIME_PROVIDER ?? "").trim().toLowerCase();
  const managed = (env.DEN_RUNTIME_MANAGED ?? "").trim().toLowerCase();
  const workerId = (env.DEN_WORKER_ID ?? "").trim();
  const url = (env.DEN_ACTIVITY_HEARTBEAT_URL ?? "").trim();
  const token = (env.DEN_ACTIVITY_HEARTBEAT_TOKEN ?? "").trim();
  const featureEnabled = enabled === "1" || enabled === "true" || enabled === "yes";
  // Den sets DEN_RUNTIME_MANAGED on every instance whose idle lifecycle it owns.
  // Older Dens only sent the provider name, so that spelling stays accepted.
  const denManaged = managed === "1" || managed === "true" || managed === "yes" || provider === "daytona";

  if (!featureEnabled || !denManaged || !workerId || !url || !token) {
    return {
      enabled: false,
      workerId: "",
      url: "",
      token: "",
      intervalMs: DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS,
      activeWindowMs: DEFAULT_ACTIVITY_WINDOW_MS,
    };
  }

  const intervalSeconds = parsePositiveNumberEnv(
    env.DEN_ACTIVITY_HEARTBEAT_INTERVAL_SECONDS,
    DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS / 1000,
  );
  const activeWindowSeconds = parsePositiveNumberEnv(
    env.DEN_ACTIVITY_WINDOW_SECONDS,
    DEFAULT_ACTIVITY_WINDOW_MS / 1000,
  );

  return {
    enabled: true,
    workerId,
    url,
    token,
    intervalMs: Math.round(intervalSeconds * 1000),
    activeWindowMs: Math.round(activeWindowSeconds * 1000),
  };
}

export function buildWorkerActivityHeartbeatPayload(
  sessions: readonly unknown[],
  now: number,
  activeWindowMs: number,
): WorkerActivityHeartbeatPayload {
  let latestActivityAt = cloudComputerActivityAt();
  for (const session of sessions) {
    const activityAt = parseSessionActivityAt(session);
    if (activityAt && activityAt > latestActivityAt) latestActivityAt = activityAt;
  }

  return {
    sentAt: new Date(now).toISOString(),
    isActiveRecently: latestActivityAt > 0 && now - latestActivityAt <= activeWindowMs,
    lastActivityAt: latestActivityAt > 0 ? new Date(latestActivityAt).toISOString() : null,
    openSessionCount: sessions.length,
  };
}

export async function postWorkerActivityHeartbeat(input: {
  config: WorkerActivityHeartbeatConfig;
  sessions: readonly unknown[];
  fetchImpl?: HeartbeatFetch;
  now?: () => number;
}): Promise<WorkerActivityHeartbeatPayload | null> {
  if (!input.config.enabled) return null;

  const payload = buildWorkerActivityHeartbeatPayload(
    input.sessions,
    input.now ? input.now() : Date.now(),
    input.config.activeWindowMs,
  );
  const response = await (input.fetchImpl ?? externalFetch)(input.config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.config.token}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new Error(`heartbeat_failed:${response.status}`);
  // Den may still return an `enginePolicy` field; it no longer applies, since
  // OpenCode v2 is the only engine. Drain the body so the connection is reused.
  await response.body?.cancel().catch(() => undefined);
  return payload;
}

/**
 * The most recent sessions (up to 200 per folder) of every local workspace,
 * read natively from OpenCode v2. Empty while the engine is not running.
 */
export async function listOpenV2Sessions(
  config: Pick<ServerConfig, "workspaces">,
  connection: WorkerActivityEngineConnection | undefined,
  fetchImpl: HeartbeatFetch = loopbackFetch,
): Promise<readonly unknown[]> {
  if (!connection) return [];
  const authorization = `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`;
  const sessions = new Map<string, unknown>();
  const local = config.workspaces.filter((workspace) => workspace.workspaceType === "local");
  for (const workspace of local) {
    const url = new URL("/api/session", connection.url);
    url.searchParams.set("limit", "200");
    url.searchParams.set("location[directory]", workspace.path);
    const response = await fetchImpl(url.toString(), {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`opencode_request_failed:${response.status}`);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error("opencode_invalid_response");
    for (const row of payload.data) {
      const info = isRecord(row) && isRecord(row.info) ? row.info : row;
      const id = isRecord(info) && typeof info.id === "string" ? info.id : undefined;
      if (id) sessions.set(id, row);
    }
  }
  return [...sessions.values()];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function startWorkerActivityHeartbeat(
  config: ServerConfig,
  logger: WorkerActivityHeartbeatLogger,
  options: {
    /** The running OpenCode v2 engine, or undefined while it is not running. */
    engineConnection: () => WorkerActivityEngineConnection | undefined;
    env?: HeartbeatEnv;
    fetchImpl?: HeartbeatFetch;
    listSessions?: () => Promise<readonly unknown[]>;
    now?: () => number;
  },
): WorkerActivityHeartbeatHandle | null {
  const heartbeatConfig = resolveWorkerActivityHeartbeatConfig(options.env);
  if (!heartbeatConfig.enabled) return null;

  logger.log("info", "Worker activity heartbeat enabled", {
    workerId: heartbeatConfig.workerId,
    intervalMs: heartbeatConfig.intervalMs,
    activeWindowMs: heartbeatConfig.activeWindowMs,
  });

  const listSessions = options.listSessions ?? (() => listOpenV2Sessions(config, options.engineConnection()));
  let inFlight: Promise<void> | undefined;
  const runHeartbeat = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(listSessions)
      .then((sessions) => postWorkerActivityHeartbeat({
        config: heartbeatConfig,
        sessions,
        fetchImpl: options.fetchImpl,
        now: options.now,
      }))
      .then(() => undefined)
      .catch((error) => {
        logger.log("warn", "Worker activity heartbeat failed", { error: errorMessage(error) });
      })
      .finally(() => { inFlight = undefined; });
    return inFlight;
  };

  void runHeartbeat();
  const interval = setInterval(() => void runHeartbeat(), heartbeatConfig.intervalMs);
  return { stop: () => clearInterval(interval) };
}
