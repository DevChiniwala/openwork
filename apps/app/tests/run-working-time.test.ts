import { expect, test } from "bun:test"
import type { UIMessage } from "ai"
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "../src/app/types"
import { getRunStartedAt } from "../src/components/chat/utils"

function user(id: string, created?: number): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text: id }], ...(created === undefined ? {} : { metadata: { opencode: { created } } }) }
}

function reply(id: string, created: number, completed?: number): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text: id }], metadata: { opencode: { created, ...(completed === undefined ? {} : { completed }) } } }
}

test("a run starts at the message that started it", () => {
  expect(getRunStartedAt([user("first", 1_000), reply("answer", 1_100)])).toBe(1_000)
  expect(getRunStartedAt([])).toBeNull()
})

test("a follow-up sent while the reply is still being written keeps the run's start", () => {
  expect(getRunStartedAt([user("first", 1_000), reply("answer", 1_100), user("steer", 5_000)])).toBe(1_000)
  // The reply finished after the follow-up arrived, so it was still working when it was sent.
  expect(getRunStartedAt([user("first", 1_000), reply("answer", 1_100, 9_000), user("steer", 5_000), reply("adjusted", 9_100)])).toBe(1_000)
})

test("several follow-ups in one run all count from the first message", () => {
  expect(getRunStartedAt([
    user("first", 1_000), reply("one", 1_100, 9_000),
    user("steer", 5_000), reply("two", 9_100, 20_000),
    user("again", 15_000), reply("three", 20_100),
  ])).toBe(1_000)
})

test("a message sent after the reply finished starts a new run", () => {
  expect(getRunStartedAt([user("first", 1_000), reply("answer", 1_100, 3_000), user("next", 8_000)])).toBe(8_000)
  expect(getRunStartedAt([user("first", 1_000), reply("answer", 1_100, 3_000), user("next", 8_000), reply("new answer", 8_100)])).toBe(8_000)
})

test("a message sent after an error starts a new run", () => {
  const error = { ...reply("error", 2_000), id: `${SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX}first` }
  expect(getRunStartedAt([user("first", 1_000), reply("answer", 1_100), error, user("retry", 8_000)])).toBe(8_000)
})

test("an old reply left unfinished by an interrupted run does not join the next run", () => {
  // Interrupted runs leave replies without a completion time in history.
  expect(getRunStartedAt([user("first", 1_000), reply("interrupted", 1_100), user("next", 90_000), reply("new answer", 90_100)])).toBe(90_000)
})

test("a pending follow-up without a server time keeps the run's start", () => {
  expect(getRunStartedAt([user("first", 1_000), reply("answer", 1_100), user("pending")])).toBe(1_000)
  expect(getRunStartedAt([user("first", 1_000), reply("answer", 1_100, 3_000), user("pending")])).toBeNull()
})
