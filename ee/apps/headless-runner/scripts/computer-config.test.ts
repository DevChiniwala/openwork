import assert from "node:assert/strict"
import { test } from "node:test"
import { loadConfig } from "../src/config.js"
const base = { HEADLESS_API_TOKEN: "test-token-123456789012345678901234567890", HEADLESS_MODEL_PROTOCOL: "anthropic", HEADLESS_MODEL_BASE_URL: "https://example.com/v1", HEADLESS_MODEL: "test-model" }
test("computer remains off by default", () => assert.equal(loadConfig(base).computer, undefined))
test("Freestyle's existing settings still select Freestyle", () => {
  const config = loadConfig({ ...base, HEADLESS_COMPUTER: "freestyle", FREESTYLE_API_KEY: "test" })
  assert.equal(config.computer?.kind, "freestyle")
  assert.equal(config.computer?.snapshot, undefined)
})
test("Daytona requires its own key and prepared computer snapshot", () => {
  assert.throws(() => loadConfig({ ...base, HEADLESS_COMPUTER: "daytona" }), /DAYTONA_API_KEY/)
  assert.throws(() => loadConfig({ ...base, HEADLESS_COMPUTER: "daytona", DAYTONA_API_KEY: "test" }), /HEADLESS_COMPUTER_SNAPSHOT/)
  assert.equal(loadConfig({ ...base, HEADLESS_COMPUTER: "daytona", DAYTONA_API_KEY: "test", HEADLESS_COMPUTER_SNAPSHOT: "computer-image" }).computer?.kind, "daytona")
})

test("VM and desktop capabilities require explicit operator configuration", () => {
  const env = { ...base, HEADLESS_COMPUTER: "daytona", DAYTONA_API_KEY: "test", HEADLESS_COMPUTER_SNAPSHOT: "computer-image" }
  assert.equal(loadConfig(env).computer?.desktop, false)
  assert.equal(loadConfig(env).computer?.sandboxClass, "container")
  const vm = loadConfig({ ...env, HEADLESS_COMPUTER_CLASS: "linux-vm", HEADLESS_COMPUTER_DESKTOP: "true" }).computer
  assert.equal(vm?.desktop, true)
  assert.equal(vm?.sandboxClass, "linux-vm")
  assert.throws(() => loadConfig({ ...env, HEADLESS_COMPUTER_DESKTOP: "true" }), /HEADLESS_COMPUTER_CLASS=linux-vm/)
})

test("a Freestyle desktop needs its desktop snapshot, and persistence and the viewer domain come from env", () => {
  const env = { ...base, HEADLESS_COMPUTER: "freestyle", FREESTYLE_API_KEY: "test", HEADLESS_COMPUTER_DESKTOP: "true" }
  assert.throws(() => loadConfig(env), /snapshot:build:freestyle-desktop/)
  const computer = loadConfig({ ...env, HEADLESS_COMPUTER_SNAPSHOT: "workbot-desktop-freestyle", HEADLESS_COMPUTER_PERSISTENT: "true", HEADLESS_COMPUTER_DOMAIN: "computers.example.com" }).computer
  assert.equal(computer?.desktop, true)
  assert.equal(computer?.persistent, true)
  assert.equal(computer?.endpointDomain, "computers.example.com")
  assert.equal(loadConfig({ ...env, HEADLESS_COMPUTER_SNAPSHOT: "desktop" }).computer?.persistent, false)
  assert.throws(() => loadConfig({ ...env, HEADLESS_COMPUTER_SNAPSHOT: "desktop", HEADLESS_COMPUTER_DOMAIN: "https://bad" }), /lowercase domain/)
})

test("Freestyle beside Daytona needs its key, and only adds to a Daytona runner", () => {
  const daytona = { ...base, HEADLESS_COMPUTER: "daytona", DAYTONA_API_KEY: "test", HEADLESS_COMPUTER_SNAPSHOT: "workbot-desktop", HEADLESS_COMPUTER_CLASS: "linux-vm", HEADLESS_COMPUTER_DESKTOP: "true" }
  assert.equal(loadConfig(daytona).freestyleComputer, undefined)
  assert.throws(() => loadConfig({ ...daytona, HEADLESS_COMPUTER_FREESTYLE_SNAPSHOT: "workbot-desktop-freestyle" }), /FREESTYLE_API_KEY/)
  const both = loadConfig({ ...daytona, HEADLESS_COMPUTER_FREESTYLE_SNAPSHOT: "workbot-desktop-freestyle", FREESTYLE_API_KEY: "test" })
  assert.equal(both.computer?.kind, "daytona")
  assert.equal(both.freestyleComputer?.kind, "freestyle")
  assert.equal(both.freestyleComputer?.snapshot, "workbot-desktop-freestyle")
  assert.equal(both.freestyleComputer?.desktop, true)
  assert.throws(() => loadConfig({ ...base, HEADLESS_COMPUTER: "freestyle", FREESTYLE_API_KEY: "test", HEADLESS_COMPUTER_FREESTYLE_SNAPSHOT: "x" }), /beside Daytona/)
})

test("each conversation's computer calls go to the provider it started on", async () => {
  const { routeComputers } = await import("../src/computer-routing.js")
  const calls: string[] = []
  const fake = (name: string) => ({
    prompt: "p", tools: [], toolNames: new Set<string>(), image: name,
    run: async (sessionId: string) => { calls.push(`${name}:${sessionId}`); return { output: "", isError: false } },
    known: () => true, prewarm: () => {}, release: () => {}, delete: async () => {}, previewSavedFile: async () => {},
    desktopViewer: async () => { calls.push(`${name}:viewer`); return { state: "paused" as const } },
  })
  const routed = routeComputers(fake("daytona"), fake("freestyle"), sessionId => sessionId === "hs_free" ? "freestyle" : sessionId === "hs_day" ? "default" : null)
  await routed.run("hs_free", "bash", {})
  await routed.run("hs_day", "bash", {})
  await routed.run("hs_old", "bash", {})
  await routed.desktopViewer?.("hs_free", { view: "computer", control: false, origin: "https://chat.example.test" })
  assert.deepEqual(calls, ["freestyle:hs_free", "daytona:hs_day", "daytona:hs_old", "freestyle:viewer"])
})
