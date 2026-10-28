import { formatHour, type ProactivePolicy } from "@openwork/automations/proactive"
import type { AgentInstanceOverrides } from "@openwork-ee/den-db/schema"
import {
  AGENT_PREFERENCE_COPY,
  AGENT_PREFERENCE_FIELDS,
  AGENT_RESPONSIBILITIES,
  AGENT_RESPONSIBILITY_COPY,
  EMPTY_AGENT_PREFERENCES,
  agentChangeFieldSchema,
  agentHourWindowSchema,
  agentPreferencesSchema,
  agentResponsibilitySchema,
  type AgentChangeField,
  type AgentChangeSource,
  type AgentHourWindow,
  type AgentPreferenceField,
  type AgentPreferences,
  type AgentResponsibility,
  type MemberAgentChange,
  type MemberAgentInput,
  type MemberAgentLimits,
  type WorkbotProactiveSettings,
} from "@openwork/types/den/workbot-proactive"
import { z } from "zod"

/**
 * My agent (`workbotAgentLibrary`): what a member tells their agent in their own words, the limits they narrow, and
 * the short change log behind "Saved from chat at 11:20 AM · Undo". Pure: no database, no clock, no ids of its own.
 *
 * A member can only narrow the organization's limits: their hours sit inside the admin's, their daily limit is at
 * most the admin's, and a quiet window only holds messages back. Whatever is stored is read clamped to the current
 * organization policy, so an admin who later narrows theirs always wins.
 */

const LOG_LIMIT = 40

const changeValueSchema = z.union([z.string(), z.number(), z.boolean(), z.object({ startHour: z.number(), endHour: z.number() }), z.null()])
type ChangeValue = z.infer<typeof changeValueSchema>

const storedChangeSchema = z.object({
  id: z.string().min(1).max(64),
  /** Every field one request changed shares its save id, so "undo" reverts the whole save. */
  save: z.string().min(1).max(64),
  field: agentChangeFieldSchema,
  previous: changeValueSchema,
  value: changeValueSchema,
  source: z.enum(["chat", "page"]),
  at: z.number(),
  undoneAt: z.number().optional(),
})
export type StoredAgentChange = z.infer<typeof storedChangeSchema>

const storedPreferencesSchema = z.object({ v: z.literal(1), words: agentPreferencesSchema, log: z.array(storedChangeSchema) })
export type StoredAgentPreferences = z.infer<typeof storedPreferencesSchema>

export function emptyStoredPreferences(): StoredAgentPreferences {
  return { v: 1, words: { ...EMPTY_AGENT_PREFERENCES }, log: [] }
}

export function parseStoredPreferences(value: string | null | undefined): StoredAgentPreferences {
  if (!value) return emptyStoredPreferences()
  try {
    const parsed = storedPreferencesSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : emptyStoredPreferences()
  } catch {
    return emptyStoredPreferences()
  }
}

// ---- Limits -------------------------------------------------------------------------------------------------------

function window(value: unknown): AgentHourWindow | null {
  const parsed = agentHourWindowSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function cap(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10 ? value : null
}

/** The member's stored narrower choices, field by field: anything unreadable is simply not there. */
function memberOverrides(overrides: AgentInstanceOverrides | null | undefined) {
  return { hours: window(overrides?.hours), dailyCap: cap(overrides?.dailyCap), quietWindow: window(overrides?.quietWindow) }
}

/** What the agent follows for this member: their narrower choices inside the organization's current limits. */
export function memberLimits(settings: WorkbotProactiveSettings, overrides: AgentInstanceOverrides | null | undefined): MemberAgentLimits {
  const admin = { startHour: settings.startHour, endHour: settings.endHour, dailyCap: settings.dailyCap }
  const mine = memberOverrides(overrides)
  const start = mine.hours ? Math.max(mine.hours.startHour, admin.startHour) : admin.startHour
  const end = mine.hours ? Math.min(mine.hours.endHour, admin.endHour) : admin.endHour
  // Hours that no longer overlap the organization's (the admin moved theirs) fall back to the organization's.
  const hours = end > start ? { startHour: start, endHour: end } : { startHour: admin.startHour, endHour: admin.endHour }
  const dailyCap = Math.min(mine.dailyCap ?? admin.dailyCap, admin.dailyCap)
  return {
    workingDays: settings.workingDays,
    ...hours,
    dailyCap,
    quietWindow: mine.quietWindow,
    admin,
    narrowed: { hours: hours.startHour !== admin.startHour || hours.endHour !== admin.endHour, dailyCap: dailyCap < admin.dailyCap },
  }
}

export function memberPolicy(limits: MemberAgentLimits): ProactivePolicy {
  return { workingDays: limits.workingDays, startHour: limits.startHour, endHour: limits.endHour, dailyCap: limits.dailyCap }
}

export function hoursLabel(hours: { startHour: number; endHour: number }) {
  return `${formatHour(hours.startHour)}–${formatHour(hours.endHour)}`
}

// ---- Changes ------------------------------------------------------------------------------------------------------

/** Everything a member controls, as one value per change field. */
type MemberAgentState = {
  words: AgentPreferences
  hours: AgentHourWindow | null
  dailyCap: number | null
  quietWindow: AgentHourWindow | null
  muted: Set<AgentResponsibility>
}

function isResponsibility(field: AgentChangeField): field is AgentResponsibility {
  return agentResponsibilitySchema.safeParse(field).success
}

function isPreferenceField(field: AgentChangeField): field is AgentPreferenceField {
  return AGENT_PREFERENCE_FIELDS.some((entry) => entry === field)
}

function valueOf(state: MemberAgentState, field: AgentChangeField): ChangeValue {
  if (isPreferenceField(field)) return state.words[field]
  if (isResponsibility(field)) return state.muted.has(field)
  if (field === "hours") return state.hours
  if (field === "dailyCap") return state.dailyCap
  return state.quietWindow
}

function assign(state: MemberAgentState, field: AgentChangeField, value: ChangeValue) {
  if (isPreferenceField(field)) state.words[field] = typeof value === "string" ? value : ""
  else if (isResponsibility(field)) {
    if (value === true) state.muted.add(field)
    else state.muted.delete(field)
  } else if (field === "hours") state.hours = window(value)
  else if (field === "dailyCap") state.dailyCap = cap(value)
  else state.quietWindow = window(value)
}

function sameValue(left: ChangeValue, right: ChangeValue) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function quote(text: string) {
  return `“${text}”`
}

/** One change in a few words, as the member and the chat reply read it. */
export function describeChange(field: AgentChangeField, value: ChangeValue, admin: { startHour: number; endHour: number; dailyCap: number }): string {
  if (isPreferenceField(field)) {
    const text = typeof value === "string" ? value.trim() : ""
    return text ? `${AGENT_PREFERENCE_COPY[field].label}: ${quote(text)}` : `${AGENT_PREFERENCE_COPY[field].label}: cleared`
  }
  if (isResponsibility(field)) return `${value === true ? "Stopped" : "Turned back on"}: ${AGENT_RESPONSIBILITY_COPY[field].label}`
  if (field === "hours") {
    const hours = window(value)
    return hours ? `Hours: ${hoursLabel(hours)}` : `Hours: back to your admin's ${hoursLabel(admin)}`
  }
  if (field === "dailyCap") {
    const limit = cap(value)
    return limit ? `Daily limit: ${limit} a day` : `Daily limit: back to your admin's ${admin.dailyCap} a day`
  }
  const quiet = window(value)
  return quiet ? `Only urgent messages ${hoursLabel(quiet)}` : "Only-urgent hours removed"
}

export type MemberAgentChangeResult =
  | {
      ok: true
      overrides: AgentInstanceOverrides
      stored: StoredAgentPreferences
      /** What this request changed (or undid), in a few words each. */
      lines: string[]
      undid: boolean
      /** The member's hours or quiet window changed: the agent should look again now. */
      wake: boolean
    }
  | { ok: false; status: 400 | 409; error: "limit_wider_than_admin" | "nothing_to_undo" | "undo_superseded" | "undo_alone"; message: string }

/** The fields of a request that only My agent understands. */
export function usesAgentLibrary(input: MemberAgentInput) {
  return input.preferences !== undefined || input.hours !== undefined || input.dailyCap !== undefined || input.quietWindow !== undefined || input.undo !== undefined
}

/**
 * Applies a member's request (their words, narrower limits, mutes, or an undo) to what they have now, logging each
 * field that changed with where it came from. Refuses anything wider than the organization allows.
 */
export function applyMemberAgentChange(input: {
  request: MemberAgentInput
  overrides: AgentInstanceOverrides | null | undefined
  stored: StoredAgentPreferences
  settings: WorkbotProactiveSettings
  source: AgentChangeSource
  now: number
  /** A fresh id for a change or a save. */
  newId: () => string
}): MemberAgentChangeResult {
  const { request, settings, now } = input
  const admin = { startHour: settings.startHour, endHour: settings.endHour, dailyCap: settings.dailyCap }
  const mine = memberOverrides(input.overrides)
  const mutedNow = new Set((input.overrides?.muted ?? []).flatMap((value) => {
    const parsed = agentResponsibilitySchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  }))
  const state: MemberAgentState = { words: { ...input.stored.words }, hours: mine.hours, dailyCap: mine.dailyCap, quietWindow: mine.quietWindow, muted: mutedNow }
  const log = input.stored.log.map((entry) => ({ ...entry }))
  const lines: string[] = []
  let wake = false

  const finish = (undid: boolean): MemberAgentChangeResult => {
    const overrides: AgentInstanceOverrides = { ...input.overrides, muted: AGENT_RESPONSIBILITIES.filter((responsibility) => state.muted.has(responsibility)) }
    if (state.hours) overrides.hours = state.hours
    else delete overrides.hours
    if (state.dailyCap !== null) overrides.dailyCap = state.dailyCap
    else delete overrides.dailyCap
    if (state.quietWindow) overrides.quietWindow = state.quietWindow
    else delete overrides.quietWindow
    return { ok: true, overrides, stored: { v: 1, words: state.words, log: log.slice(-LOG_LIMIT) }, lines, undid, wake }
  }

  if (request.undo !== undefined) {
    const others = { ...request }
    delete others.undo
    if (Object.values(others).some((value) => value !== undefined)) {
      return { ok: false, status: 400, error: "undo_alone", message: "Undo on its own, then make the next change." }
    }
    const live = log.filter((entry) => entry.undoneAt === undefined)
    const latestFor = (field: AgentChangeField) => live.filter((entry) => entry.field === field).at(-1)
    const targets = request.undo === "last"
      ? live.filter((entry) => entry.save === live.at(-1)?.save)
      : live.filter((entry) => entry.id === request.undo)
    if (!targets.length) return { ok: false, status: 409, error: "nothing_to_undo", message: "There is nothing to undo." }
    if (targets.some((entry) => latestFor(entry.field)?.id !== entry.id)) {
      return { ok: false, status: 409, error: "undo_superseded", message: "That was changed again since. Undo the newer change first." }
    }
    for (const entry of targets) {
      assign(state, entry.field, entry.previous)
      entry.undoneAt = now
      lines.push(describeChange(entry.field, entry.previous, admin))
      if (entry.field === "hours" || entry.field === "quietWindow") wake = true
    }
    return finish(true)
  }

  // A member narrows, never widens.
  if (request.hours && (request.hours.startHour < admin.startHour || request.hours.endHour > admin.endHour)) {
    return { ok: false, status: 400, error: "limit_wider_than_admin", message: `Your admin allows ${hoursLabel(admin)}. Choose hours inside that.` }
  }
  if (typeof request.dailyCap === "number" && request.dailyCap > admin.dailyCap) {
    return { ok: false, status: 400, error: "limit_wider_than_admin", message: `Your admin allows ${admin.dailyCap} a day. Choose ${admin.dailyCap} or fewer.` }
  }

  const save = input.newId()
  const set = (field: AgentChangeField, value: ChangeValue) => {
    const previous = valueOf(state, field)
    if (sameValue(previous, value)) return
    assign(state, field, value)
    const saved = valueOf(state, field)
    log.push({ id: input.newId(), save, field, previous, value: saved, source: input.source, at: now })
    lines.push(describeChange(field, saved, admin))
    if (field === "hours" || field === "quietWindow") wake = true
  }
  for (const field of AGENT_PREFERENCE_FIELDS) {
    const text = request.preferences?.[field]
    if (text !== undefined) set(field, text)
  }
  for (const responsibility of request.mute ?? []) set(responsibility, true)
  for (const responsibility of request.unmute ?? []) set(responsibility, false)
  // The organization's own hours or limit, asked for again, are no narrowing: they follow the admin from then on.
  if (request.hours !== undefined) set("hours", request.hours && (request.hours.startHour !== admin.startHour || request.hours.endHour !== admin.endHour) ? request.hours : null)
  if (request.dailyCap !== undefined) set("dailyCap", request.dailyCap === admin.dailyCap ? null : request.dailyCap)
  if (request.quietWindow !== undefined) set("quietWindow", request.quietWindow)
  return finish(false)
}

/** The member's recent changes, newest first, as the page and chat read them. */
export function memberAgentChanges(stored: StoredAgentPreferences, settings: WorkbotProactiveSettings, limit = 20): MemberAgentChange[] {
  const admin = { startHour: settings.startHour, endHour: settings.endHour, dailyCap: settings.dailyCap }
  return [...stored.log].reverse().slice(0, limit).map((entry) => ({
    id: entry.id,
    field: entry.field,
    summary: describeChange(entry.field, entry.value, admin),
    source: entry.source,
    at: new Date(entry.at).toISOString(),
    undone: entry.undoneAt !== undefined,
  }))
}

/** What chat says back after a save: exactly what was saved, how to revert it, and where to see it. */
export function savedReply(result: { lines: readonly string[]; undid: boolean; undoable: boolean }, link: string): string {
  if (!result.lines.length) return `Nothing changed. My bot: ${link}`
  const list = result.lines.map((line) => `- ${line}`).join("\n")
  if (result.undid) return `Undone. Now:\n${list}\nMy bot: ${link}`
  return `Saved:\n${list}\n${result.undoable ? 'Reply "undo" to revert. ' : ""}My bot: ${link}`
}

/** On/off and snooze, in the same words; they are not in the change log (the switch itself undoes them). */
export function choiceLines(request: Pick<MemberAgentInput, "on" | "snooze">): string[] {
  return [
    ...(request.on === undefined ? [] : [request.on ? "Turned on" : "Turned off"]),
    ...(request.snooze === undefined ? [] : [request.snooze === null ? "Resumed" : "Snoozed until your next working morning"]),
  ]
}
