import { expect, test } from "bun:test"
import type { ActivationState } from "@openwork/types/den/activation"
import {
  activationCardModel,
  createActivationReporter,
  draftUsesSkill,
  shouldReportActivationEvent,
} from "../src/react-app/domains/cloud/activation/activation-model"

const ids = ["first_response", "invite_teammate", "use_skill", "own_provider", "gateway_provider", "connector"] as const

function state(done: readonly (typeof ids)[number][], extra: Partial<ActivationState> = {}, locked: Partial<Record<(typeof ids)[number], string>> = {}): ActivationState {
  return {
    steps: ids.map((id) => ({ id, done: done.includes(id), ...(locked[id] ? { lockedReason: locked[id] } : {}) })),
    dismissed: false,
    ...extra,
  }
}

test("the card stays hidden before the first answer, while off, and at six of six", () => {
  expect(activationCardModel(null).presentation).toBe("hidden")
  expect(activationCardModel(undefined).presentation).toBe("hidden")
  expect(activationCardModel(state([])).presentation).toBe("hidden")
  expect(activationCardModel(state([...ids])).presentation).toBe("hidden")
})

test("after the first answer the card shows 1 of 6 and the next step; hiding leaves one Next line", () => {
  const model = activationCardModel(state(["first_response"]))
  expect(model).toMatchObject({ presentation: "full", done: 1, total: 6, next: "Invite a teammate", dismissed: false })
  if (model.presentation === "hidden") throw new Error("expected the card")
  expect(model.rows.map((row) => [row.id, row.state, row.action?.label ?? null])).toEqual([
    ["first_response", "done", null],
    ["invite_teammate", "open", "Invite"],
    ["use_skill", "open", "Try a skill"],
    ["own_provider", "open", "Add key"],
    ["gateway_provider", "open", "Share"],
    ["connector", "open", "Connect"],
  ])
  expect(activationCardModel(state(["first_response"], { dismissed: true }))).toMatchObject({ presentation: "next", next: "Invite a teammate" })
})

test("a member sees locked rows with who can do them and no action", () => {
  const model = activationCardModel(state(["first_response", "invite_teammate"], {}, { gateway_provider: "Avery Owner manages AI Gateway" }))
  if (model.presentation === "hidden") throw new Error("expected the card")
  const gateway = model.rows.find((row) => row.id === "gateway_provider")
  expect(gateway).toEqual({ id: "gateway_provider", title: "Share a provider on AI Gateway", state: "locked", line: "Avery Owner manages AI Gateway", action: null })
  expect(model.next).toBe("Use a skill")
})

test("steps are reported only while Den shows the checklist and the step is open", () => {
  expect(shouldReportActivationEvent(null, "first_response")).toBe(false)
  expect(shouldReportActivationEvent(state([]), "first_response")).toBe(true)
  expect(shouldReportActivationEvent(state(["first_response"]), "first_response")).toBe(false)
  expect(shouldReportActivationEvent(state([]), "dismiss")).toBe(true)
  expect(shouldReportActivationEvent(state([], { dismissed: true }), "dismiss")).toBe(false)
  expect(draftUsesSkill([{ type: "text" }, { type: "skill" }])).toBe(true)
  expect(draftUsesSkill([{ type: "connect-skill" }])).toBe(true)
  expect(draftUsesSkill([{ type: "text" }])).toBe(false)
})

test("the reporter sends one event per step at a time, per organization, and swallows failures", async () => {
  const states = new Map<string, ActivationState | null>([["org_a", state([])], ["org_b", state([])], ["org_off", null]])
  const sent: string[] = []
  let fail = false
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const report = createActivationReporter<{ key: string }>({
    readState: (scope) => states.get(scope.key),
    send: async (scope, step) => {
      sent.push(`${scope.key}:${step}`)
      await gate
      if (fail) throw new Error("offline")
      return state(["first_response"])
    },
    onState: (scope, next) => { states.set(scope.key, next) },
  })
  const first = report({ key: "org_a" }, "first_response", 2100)
  const duplicate = report({ key: "org_a" }, "first_response", 2100)
  const other = report({ key: "org_b" }, "first_response")
  expect(await report({ key: "org_off" }, "first_response")).toBe(false)
  release()
  expect(await Promise.all([first, duplicate, other])).toEqual([true, false, true])
  expect(sent).toEqual(["org_a:first_response", "org_b:first_response"])
  // Den now counts it: nothing more is sent for this organization.
  expect(await report({ key: "org_a" }, "first_response")).toBe(false)
  fail = true
  expect(await report({ key: "org_a" }, "use_skill")).toBe(false)
  expect(sent).toEqual(["org_a:first_response", "org_b:first_response", "org_a:use_skill"])
})
