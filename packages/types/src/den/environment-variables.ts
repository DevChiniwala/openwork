import { z } from "zod"

/**
 * Organization environment variables: admins define them in OpenWork Cloud and
 * desktops add them to the agent's (OpenCode's) process environment.
 *
 * Shared by den-api (validation and responses), den-web (editor) and the
 * desktop (settings and engine environment).
 */

/**
 * How a variable gets its value: `admin` puts a value on each assignment
 * (everyone, a team, one person); `per_member` lets each recipient set their own.
 */
export const ENVIRONMENT_VARIABLE_VALUE_MODES = ["admin", "per_member"] as const
export const environmentVariableValueModeSchema = z.enum(ENVIRONMENT_VARIABLE_VALUE_MODES)
export type EnvironmentVariableValueMode = z.infer<typeof environmentVariableValueModeSchema>

export const ENVIRONMENT_VARIABLE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
export const ENVIRONMENT_VARIABLE_KEY_MAX_LENGTH = 255
export const ENVIRONMENT_VARIABLE_VALUE_MAX_LENGTH = 32_768

/**
 * Names the desktop owns or needs to start the agent. Deploying them would
 * break every recipient's agent, so Den refuses them.
 */
const RESERVED_KEYS = new Set([
  "PATH", "HOME", "USER", "USERNAME", "LOGNAME", "SHELL", "PWD", "OLDPWD", "TMPDIR", "TEMP", "TMP",
  "LANG", "TERM", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "APPDATA", "LOCALAPPDATA", "USERPROFILE", "SYSTEMROOT", "COMSPEC", "PATHEXT",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
])
const RESERVED_PREFIXES = ["OPENWORK_", "OPENCODE_", "BUN_", "ELECTRON_"]

/** Why a key cannot be deployed, or null when it can. */
export function environmentVariableKeyProblem(key: string): string | null {
  if (!key) return "Enter a key."
  if (key.length > ENVIRONMENT_VARIABLE_KEY_MAX_LENGTH) return `Use at most ${ENVIRONMENT_VARIABLE_KEY_MAX_LENGTH} characters.`
  if (!ENVIRONMENT_VARIABLE_KEY_PATTERN.test(key)) return "Use letters, numbers and underscores, starting with a letter or underscore."
  const upper = key.toUpperCase()
  if (RESERVED_KEYS.has(upper)) return `${key} is used by the desktop app and can't be deployed.`
  const prefix = RESERVED_PREFIXES.find((candidate) => upper.startsWith(candidate))
  if (prefix) return `Keys starting with ${prefix} are reserved for OpenWork.`
  return null
}

export const environmentVariableKeySchema = z.string().trim().superRefine((value, ctx) => {
  const problem = environmentVariableKeyProblem(value)
  if (problem) ctx.addIssue({ code: "custom", message: problem })
})

export const environmentVariableValueSchema = z.string().min(1).max(ENVIRONMENT_VARIABLE_VALUE_MAX_LENGTH)

/**
 * Where a person's effective value comes from: an assignment to everyone, to
 * one of their teams, directly to them, or their own value.
 */
export const environmentVariableValueSourceSchema = z.enum(["everyone", "team", "direct", "own"])
export type EnvironmentVariableValueSource = z.infer<typeof environmentVariableValueSourceSchema>

/**
 * An assignment that gives this person a value, by name ("Everyone in Acme",
 * "Sales", "Directly to you"). Never the value.
 */
export const environmentVariableAssignmentOptionSchema = z.object({
  accessId: z.string(),
  kind: z.enum(["everyone", "team", "direct"]),
  label: z.string(),
})
export type EnvironmentVariableAssignmentOption = z.infer<typeof environmentVariableAssignmentOptionSchema>

/**
 * One variable as the desktop applies it. `value` is null when nothing is set
 * for this person yet. `editable` is true only for variables each person sets
 * themselves: everything else is provisioned by an admin and read-only.
 * `assignments` lists every assignment that gives a value (admin mode), and
 * `selectedAccessId` the one in use; the person may choose another.
 */
export const resolvedEnvironmentVariableSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  valueMode: environmentVariableValueModeSchema,
  source: environmentVariableValueSourceSchema.nullable(),
  editable: z.boolean(),
  assignments: z.array(environmentVariableAssignmentOptionSchema),
  selectedAccessId: z.string().nullable(),
  value: z.string().nullable(),
  updatedAt: z.string(),
})
export type ResolvedEnvironmentVariable = z.infer<typeof resolvedEnvironmentVariableSchema>

export const resolvedEnvironmentVariablesResponseSchema = z.object({
  environmentVariables: z.array(resolvedEnvironmentVariableSchema),
})
export type ResolvedEnvironmentVariablesResponse = z.infer<typeof resolvedEnvironmentVariablesResponseSchema>
