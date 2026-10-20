import { headlessRunnerConfig, type HeadlessRunnerDeps } from "@openwork-ee/headless-protocol"
import { DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS } from "../mcp/headless-run-token.js"
import type { HeadlessIndexKind } from "./session-index.js"

/**
 * Den's wiring for the shared headless runner: its address from the environment, and member-scoped MCP tokens from
 * Den's minter. The client, its schemas and the step labels live in @openwork-ee/headless-protocol.
 */
export * from "@openwork-ee/headless-protocol"

/**
 * `indexKind`: which surface the turns belong to (Automations pass `automation`, Slack wraps these deps with `slack`),
 * so each turn also carries an index capability. Without it none is minted.
 */
export function defaultHeadlessRunnerDeps(
  env: Record<string, string | undefined> = process.env,
  options: { indexKind?: HeadlessIndexKind } = {},
): HeadlessRunnerDeps | null {
  const config = headlessRunnerConfig(env)
  // Loaded lazily: the minter pulls in the auth and database modules. A resume grant comes back only where
  // `headlessDurableTurns` is on and the turn's session and message are known; an index capability only where the kind
  // and session are known.
  const mintToken: HeadlessRunnerDeps["mintToken"] = async (input) => {
    const { token, resumeGrant, modelAccess, indexCapability } = await (await import("./resume-grants.js")).mintHeadlessTurnCredentials({
      ...input,
      ...(options.indexKind ? { indexKind: options.indexKind } : {}),
    })
    return { token, ...(resumeGrant ? { resumeGrant } : {}), ...(modelAccess ? { modelAccess } : {}), ...(indexCapability ? { indexCapability } : {}) }
  }
  // Every cloud-agent turn gets its model through the organization's AI Gateway.
  const modelAccessRequired: HeadlessRunnerDeps["modelAccessRequired"] = () => true
  return config ? { config, fetch, mintToken, modelAccessRequired, maxTokenTtlMs: DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS } : null
}

/**
 * Feature `headlessDurableTurns`: whether Den sends the organization's headless turns with `execution: "steps"`, so the
 * runner runs them one step at a time and a runner deploy switches between steps. The same feature mints the turns'
 * resume grants (resume-grants.ts), so one switch turns on both and off both. A failed read sends the turn exactly as
 * without the feature.
 */
export async function headlessDurableTurnsEnabled(organizationId: string): Promise<boolean> {
  try {
    // Loaded lazily: the feature reader pulls in the database modules.
    const { organizationFeatureEnabled } = await import("../features.js")
    return await organizationFeatureEnabled(organizationId, "headlessDurableTurns")
  } catch {
    return false
  }
}
