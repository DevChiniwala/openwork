import assert from "node:assert/strict"
import { test } from "node:test"
import { createProviderCatalog } from "../src/provider-catalog.js"
import { runProviderTest } from "../src/provider-test.js"
import type { ProviderTestDependencies } from "../src/provider-test.js"

const catalog = createProviderCatalog({
  anthropic: { npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_API_KEY"] },
  openai: { npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"] },
  "amazon-bedrock": { npm: "@ai-sdk/amazon-bedrock", env: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] },
})

type Sent = { url: string; headers: Headers; body: unknown }

function dependencies(respond: (sent: Sent) => Response, sent: Sent[] = []): ProviderTestDependencies {
  return {
    catalog,
    now: () => new Date("2026-10-27T12:00:00Z"),
    mintGcpAccessToken: async () => ({ kind: "error", message: "unused" }),
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const entry = { url: request.url, headers: request.headers, body: JSON.parse(await request.text()) }
      sent.push(entry)
      return respond(entry)
    },
  }
}

test("a working Anthropic key sends one short prompt to the chosen model", async () => {
  const sent: Sent[] = []
  const result = await runProviderTest({ providerId: "anthropic", model: "claude-sonnet-5", settings: {}, credential: { kind: "api_key", secret: "sk-ant-fixture-key-000000" } },
    dependencies(() => Response.json({ content: [{ type: "text", text: "OK" }] }), sent))
  assert.deepEqual(result, { ok: true, model: "claude-sonnet-5", status: 200, code: null, message: null })
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.url, "https://api.anthropic.com/v1/messages")
  assert.equal(sent[0]?.headers.get("x-api-key"), "sk-ant-fixture-key-000000")
  assert.equal(sent[0]?.headers.get("anthropic-version"), "2023-06-01")
  assert.deepEqual(sent[0]?.body, { model: "claude-sonnet-5", max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word OK." }] })
})

test("OpenAI is tested through the Responses API with a bearer key", async () => {
  const sent: Sent[] = []
  await runProviderTest({ providerId: "openai", model: "gpt-6-luna", settings: {}, credential: { kind: "api_key", secret: "sk-openai-fixture-0000" } },
    dependencies(() => Response.json({ output: [] }), sent))
  assert.equal(sent[0]?.url, "https://api.openai.com/v1/responses")
  assert.equal(sent[0]?.headers.get("authorization"), "Bearer sk-openai-fixture-0000")
})

test("a rejected key fails with a plain message and never echoes the key", async () => {
  const secret = "sk-ant-fixture-key-000000"
  const result = await runProviderTest({ providerId: "anthropic", model: "claude-sonnet-5", settings: {}, credential: { kind: "api_key", secret } },
    dependencies(() => Response.json({ error: { message: `invalid x-api-key ${secret}` } }, { status: 401 })))
  assert.equal(result.ok, false)
  assert.equal(result.code, "provider_authentication_failed")
  assert.equal(result.status, 401)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
})

test("a missing model includes the provider's reason without the key", async () => {
  const secret = "sk-openai-fixture-0000"
  const result = await runProviderTest({ providerId: "openai", model: "gpt-unknown", settings: {}, credential: { kind: "api_key", secret } },
    dependencies(() => Response.json({ error: { message: `The model gpt-unknown does not exist (key ${secret})` } }, { status: 404 })))
  assert.equal(result.code, "model_not_found")
  assert.match(result.message ?? "", /gpt-unknown does not exist/)
  assert.doesNotMatch(result.message ?? "", new RegExp(secret))
})

test("Bedrock keys are signed for the region and AWS error bodies are never read", async () => {
  const sent: Sent[] = []
  const secret = JSON.stringify({ accessKeyId: "AKIAFIXTURE000000000", secretAccessKey: "fixture-secret-access-key" })
  const result = await runProviderTest({ providerId: "amazon-bedrock", model: "anthropic.claude-sonnet-5", settings: { region: "us-west-2" }, credential: { kind: "aws_keys", secret } },
    dependencies(() => Response.json({ message: "signature mismatch: x-amz-security-token=leak" }, { status: 403 }), sent))
  assert.equal(sent[0]?.url, "https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-sonnet-5/converse")
  assert.match(sent[0]?.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 Credential=AKIAFIXTURE000000000\/20261027\/us-west-2\/bedrock\//)
  assert.equal(result.code, "provider_permission_denied")
  assert.doesNotMatch(JSON.stringify(result), /leak/)
})

test("an unreachable provider and an unknown provider fail without calling out", async () => {
  const unreachable = await runProviderTest({ providerId: "openai", model: "gpt-6-luna", settings: {}, credential: { kind: "api_key", secret: "sk-openai-fixture-0000" } },
    { ...dependencies(() => new Response(null)), fetch: async () => { throw new TypeError("fetch failed") } })
  assert.equal(unreachable.code, "upstream_unreachable")
  const sent: Sent[] = []
  const unknown = await runProviderTest({ providerId: "not-a-provider", model: "x", settings: {}, credential: { kind: "api_key", secret: "sk-fixture-000000" } }, dependencies(() => new Response(null), sent))
  assert.equal(unknown.code, "unsupported_provider")
  assert.equal(sent.length, 0)
})

test("a custom provider address is only tested when the operator allowlisted it", async () => {
  const credential = { kind: "api_key" as const, secret: "sk-ant-fixture-key-000000" }
  const sent: Sent[] = []
  const refused = await runProviderTest({ providerId: "anthropic", model: "claude-sonnet-5", settings: { upstreamBaseUrl: "https://attacker.example/v1" }, credential }, dependencies(() => Response.json({}), sent))
  assert.equal(refused.code, "invalid_settings")
  assert.equal(sent.length, 0)
  const previous = process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS
  process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS = "http://127.0.0.1:4100"
  try {
    const allowed = await runProviderTest({ providerId: "anthropic", model: "claude-sonnet-5", settings: { upstreamBaseUrl: "http://127.0.0.1:4100/v1" }, credential }, dependencies(() => Response.json({}), sent))
    assert.equal(allowed.ok, true)
    assert.equal(sent[0]?.url, "http://127.0.0.1:4100/v1/messages")
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS
    else process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS = previous
  }
})
