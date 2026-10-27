import assert from "node:assert/strict"
import { test } from "node:test"
import { oneAtATime } from "../src/one-at-a-time.js"

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("work for the same key takes turns, in order; other keys don't wait", async () => {
  const run = oneAtATime()
  const order: string[] = []
  const step = (name: string, ms: number) => async () => { order.push(`${name} start`); await later(ms); order.push(`${name} end`); return name }
  const results = await Promise.all([run("s1", step("a", 20)), run("s1", step("b", 1)), run("s2", step("c", 1))])
  assert.deepEqual(results, ["a", "b", "c"])
  assert.ok(order.indexOf("a end") < order.indexOf("b start"), "the second operation on s1 waits for the first")
  assert.ok(order.indexOf("c start") < order.indexOf("a end"), "another conversation's screen never waits")
})

test("a failure or an abort while waiting does not block the next in line", async () => {
  const run = oneAtATime()
  const first = run("s1", async () => { await later(20); throw new Error("busy") })
  const controller = new AbortController()
  const second = run("s1", async () => "never", controller.signal)
  const third = run("s1", async () => "third")
  const checks = [assert.rejects(first, /busy/), assert.rejects(second, /stopped/)]
  controller.abort(new Error("stopped"))
  await Promise.all(checks)
  assert.equal(await third, "third")
})
