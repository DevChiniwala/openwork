import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate } from "node:timers/promises"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { CloudProviderMaterializationProvider } from "../src/llm/cloud-provider-materialization.js"
import { bedrockCredentialError, toRuntimeProviderEnv } from "../src/llm/provider-credentials.ts"

const bedrockNpm = "@ai-sdk/amazon-bedrock"
const bedrockEnv = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_BEARER_TOKEN_BEDROCK"]
// The models.dev Bedrock entry as Den stores it.
const bedrock: Record<string, unknown> = { npm: bedrockNpm, env: bedrockEnv }
const rowId = "lpr_01kx00000000000000000keys1"

test("a catalog Bedrock row binds each delivered scoped name to its SDK option", () => {
  const runtime = toRuntimeProviderEnv({
    id: rowId,
    source: "models_dev",
    providerConfig: bedrock,
    apiKeys: { AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "secret", AWS_REGION: "eu-central-2" },
  })
  assert.deepEqual(runtime.providerConfig.env, bedrockEnv.map((name) => `LPR_KEYS1_${name}`))
  // The bearer token has no value, so the SDK keeps its own fallback for it.
  assert.deepEqual(runtime.providerConfig.options, {
    accessKeyId: "{env:LPR_KEYS1_AWS_ACCESS_KEY_ID}",
    secretAccessKey: "{env:LPR_KEYS1_AWS_SECRET_ACCESS_KEY}",
    region: "{env:LPR_KEYS1_AWS_REGION}",
  })
  assert.deepEqual(Object.keys(runtime.apiKeys ?? {}), ["LPR_KEYS1_AWS_ACCESS_KEY_ID", "LPR_KEYS1_AWS_SECRET_ACCESS_KEY", "LPR_KEYS1_AWS_REGION"])
})

test("an option the provider sets explicitly keeps precedence", () => {
  const runtime = toRuntimeProviderEnv({
    id: rowId,
    source: "models_dev",
    providerConfig: { ...bedrock, options: { region: "us-west-2" } },
    apiKeys: { AWS_BEARER_TOKEN_BEDROCK: "token", AWS_REGION: "eu-central-2" },
  })
  assert.deepEqual(runtime.providerConfig.options, { apiKey: "{env:LPR_KEYS1_AWS_BEARER_TOKEN_BEDROCK}", region: "us-west-2" })
})

test("single-env and custom providers are left as they were", () => {
  // OpenCode already hands a single env value to the SDK as apiKey.
  const openai: Record<string, unknown> = { npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"] }
  const single = toRuntimeProviderEnv({ id: rowId, source: "models_dev", providerConfig: openai, apiKeys: { OPENAI_API_KEY: "sk" } })
  assert.equal(single.providerConfig.options, undefined)
  // Custom providers keep their declared names, which the SDK reads itself.
  const custom = { id: rowId, source: "custom", providerConfig: bedrock, apiKeys: { AWS_REGION: "eu-central-2" } }
  assert.equal(toRuntimeProviderEnv(custom), custom)
})

test("saving a Bedrock credential requires a valid AWS_REGION", () => {
  const credential = (values: Record<string, string>) => JSON.stringify(values)
  assert.equal(bedrockCredentialError(bedrock, credential({ AWS_BEARER_TOKEN_BEDROCK: "token", AWS_REGION: "us-east-1" })), null)
  assert.match(bedrockCredentialError(bedrock, credential({ AWS_BEARER_TOKEN_BEDROCK: "token" })) ?? "", /AWS_REGION/)
  assert.match(bedrockCredentialError(bedrock, credential({ AWS_BEARER_TOKEN_BEDROCK: "token", AWS_REGION: "bedrock.evil.example" })) ?? "", /AWS_REGION/)
  // Nothing stored (a per-member provider's organization row) and other providers are not checked.
  assert.equal(bedrockCredentialError(bedrock, null), null)
  assert.equal(bedrockCredentialError({ npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"] }, "sk"), null)
})

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}

async function materializationFixture() {
  // Match the other Den unit harnesses: injected store/fetch never contact DB.
  process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/provider_materialization_unit_test"
  process.env.BETTER_AUTH_URL ??= "http://unit.test"
  process.env.BETTER_AUTH_SECRET ??= "synthetic-provider-materialization-unit-test-secret"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-provider-materialization-unit-test-key"
  process.env.OPENWORK_DEV_MODE ??= "1"
  const { materializeCloudWorkerProviders } = await import("../src/llm/cloud-provider-materialization.js")
  const keys = Array.from({ length: 7 }, (_, index) => `TEST_KEY_${index}`)
  const providers: CloudProviderMaterializationProvider[] = ["ipr_first", "ipr_second"].map((id) => ({
    id, source: "custom", providerId: "custom", name: id,
    providerConfig: { npm: "@ai-sdk/openai-compatible", env: keys },
    apiKey: JSON.stringify(Object.fromEntries(keys.map((key) => [key, "new-value"]))),
    models: [],
  }))
  const config = deferredResponse()
  const reads = new Map<string, ReturnType<typeof deferredResponse>>()
  const writes: { method: string; path: string; body: string | null }[] = []
  let configReads = 0
  let activeReads = 0
  let peakReads = 0
  let finished = false
  let failReadback = false
  const run = () => materializeCloudWorkerProviders({
    organizationId: createDenTypeId("organization"), workerId: createDenTypeId("worker"),
    instanceUrl: "https://worker.example.test", hostToken: "host", clientToken: "client",
    store: { listProviders: async () => providers, getActiveTokens: async () => [] },
    logger: { warn() {}, error() {} },
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname
      const method = init?.method ?? "GET"
      if (method !== "GET") {
        writes.push({ method, path, body: typeof init?.body === "string" ? init.body : null })
        return Response.json({})
      }
      if (path === "/runtime-config/providers") {
        configReads++
        if (configReads === 1) return config.promise
        if (failReadback) return new Response("readback failed", { status: 500 })
        return Response.json({ provider: Object.fromEntries(providers.map((provider) => [provider.id, {}])) })
      }
      assert.ok(path.startsWith("/env/"), path)
      const key = decodeURIComponent(path.slice("/env/".length))
      assert.equal(reads.has(key), false, `${key} must be read only once`)
      const read = deferredResponse()
      reads.set(key, read)
      activeReads++
      peakReads = Math.max(peakReads, activeReads)
      try {
        return await read.promise
      } finally {
        activeReads--
      }
    },
  }).finally(() => { finished = true })
  const release = (key: string, response = new Response(null, { status: 404 })) => {
    const read = reads.get(key)
    assert.ok(read, `${key} was launched`)
    read.resolve(response)
  }
  return {
    keys, providers, config, reads, writes, run, release,
    active: () => activeReads, peak: () => peakReads, finished: () => finished,
    failReadback: () => { failReadback = true },
  }
}

test("cloud materialization overlaps config/env reads, bounds and deduplicates env reads, and gates writes", { timeout: 15_000 }, async () => {
  const fixture = await materializationFixture()
  const result = fixture.run()
  await setImmediate()
  assert.equal(fixture.reads.size, 4, "env snapshot starts before config completes")
  assert.equal(fixture.active(), 4)
  assert.deepEqual(fixture.writes, [])
  // Complete out of order; each free slot schedules exactly one more key.
  fixture.release(fixture.keys[3])
  await setImmediate()
  assert.equal(fixture.reads.size, 5)
  fixture.release(fixture.keys[2])
  await setImmediate()
  assert.equal(fixture.reads.size, 6)
  fixture.release(fixture.keys[1])
  await setImmediate()
  assert.equal(fixture.reads.size, 7)
  for (const index of [6, 5, 4, 0]) fixture.release(fixture.keys[index])
  await setImmediate()
  assert.equal(fixture.active(), 0)
  assert.equal(fixture.finished(), false, "config snapshot still gates completion")
  assert.deepEqual(fixture.writes, [])
  fixture.config.resolve(Response.json({ provider: {} }))
  assert.equal((await result).status, "applied")
  assert.equal(fixture.peak(), 4)
  assert.deepEqual([...fixture.reads.keys()], fixture.keys)
  assert.deepEqual(fixture.writes.map(({ method, path }) => `${method} ${path}`), ["PUT /env", "PATCH /runtime-config/providers"])
})

test("cloud materialization drains env reads after config failure without writing", { timeout: 15_000 }, async () => {
  const fixture = await materializationFixture()
  const result = fixture.run()
  await setImmediate()
  fixture.config.resolve(new Response(null, { status: 500 }))
  await setImmediate()
  assert.equal(fixture.finished(), false)
  assert.deepEqual(fixture.writes, [])
  for (const key of fixture.keys) {
    fixture.release(key)
    await setImmediate()
  }
  const failed = await result
  assert.equal(failed.ok, false)
  if (!failed.ok) assert.equal(failed.reason, "engine_config_read_failed_500")
  assert.equal(fixture.active(), 0)
  assert.deepEqual(fixture.writes, [])
})

test("cloud materialization drains both snapshots after env failure and stops scheduling env reads", { timeout: 15_000 }, async () => {
  const fixture = await materializationFixture()
  const result = fixture.run()
  await setImmediate()
  fixture.release(fixture.keys[0], new Response(null, { status: 500 }))
  await setImmediate()
  assert.equal(fixture.finished(), false)
  assert.equal(fixture.reads.size, 4)
  fixture.release(fixture.keys[1], new Response(null, { status: 502 }))
  fixture.release(fixture.keys[3])
  await setImmediate()
  assert.equal(fixture.finished(), false, "the last launched env read still gates failure")
  fixture.release(fixture.keys[2])
  await setImmediate()
  assert.equal(fixture.finished(), false, "the config read still gates failure")
  fixture.config.resolve(Response.json({ provider: {} }))
  const failed = await result
  assert.equal(failed.ok, false)
  if (!failed.ok) assert.equal(failed.reason, "env_read_failed_500")
  assert.equal(fixture.active(), 0)
  assert.equal(fixture.reads.size, 4)
  assert.deepEqual(fixture.writes, [])
})

test("cloud materialization preserves provider-first rollback and env key order despite out-of-order snapshots", { timeout: 15_000 }, async () => {
  const fixture = await materializationFixture()
  fixture.failReadback()
  const result = fixture.run()
  await setImmediate()
  fixture.config.resolve(Response.json({ provider: { ipr_old: { name: "Old provider" } } }))
  await setImmediate()
  assert.deepEqual(fixture.writes, [], "env snapshots still gate writes after config succeeds")
  fixture.release(fixture.keys[3])
  await setImmediate()
  fixture.release(fixture.keys[2], Response.json({ item: { value: "old-2" } }))
  await setImmediate()
  fixture.release(fixture.keys[1])
  await setImmediate()
  fixture.release(fixture.keys[6])
  fixture.release(fixture.keys[5])
  fixture.release(fixture.keys[4], Response.json({ item: { value: "old-4" } }))
  fixture.release(fixture.keys[0])
  assert.equal((await result).ok, false)
  assert.equal(fixture.active(), 0)
  assert.deepEqual(fixture.writes.map(({ method, path }) => `${method} ${path}`), [
    "PUT /env", "PATCH /runtime-config/providers", "PATCH /runtime-config/providers", "PUT /env",
    ...[0, 1, 3, 5, 6].map((index) => `DELETE /env/${fixture.keys[index]}`),
  ])
  assert.equal(fixture.writes[2].body, JSON.stringify({ provider: {
    ipr_old: { name: "Old provider" }, ipr_first: null, ipr_second: null,
  } }))
  assert.equal(fixture.writes[3].body, JSON.stringify({ entries: [
    { key: fixture.keys[2], value: "old-2" }, { key: fixture.keys[4], value: "old-4" },
  ] }))
})
