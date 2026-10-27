import assert from "node:assert/strict"
import { test } from "node:test"
import { isAllowedRequestHeader } from "../src/protocols.js"

const opencodeGo = new URL("https://opencode.ai/inference/go/openai/v1/chat/completions")

test("OpenCode Zen and Go receive the session headers OpenCode sends", () => {
  for (const name of ["x-opencode-session", "X-OpenCode-Session-Id", "x-opencode-project", "x-opencode-client"]) {
    assert.equal(isAllowedRequestHeader("openai_compatible", name, opencodeGo), true, name)
  }
  assert.equal(isAllowedRequestHeader("anthropic", "x-opencode-session", new URL("https://api.opencode.ai/v1/messages")), true)
})

test("other upstreams never receive OpenCode's session headers", () => {
  for (const upstream of [
    "https://openrouter.ai/api/v1/chat/completions",
    "https://opencode.ai.example.com/v1/chat/completions",
    "https://notopencode.ai/v1/chat/completions",
    "http://opencode.ai/inference/go/openai/v1/chat/completions",
  ]) {
    assert.equal(isAllowedRequestHeader("openai_compatible", "x-opencode-session", new URL(upstream)), false, upstream)
  }
  assert.equal(isAllowedRequestHeader("openai_compatible", "x-session-affinity", opencodeGo), false)
  assert.equal(isAllowedRequestHeader("openai_compatible", "openai-beta", opencodeGo), true)
})
