import assert from "node:assert/strict"
import { test } from "node:test"
import { fetchSharedGatewayInventory } from "./inventory-fetch.ts"
import { API, createFakeDen, GATEWAY_KEY, PROVIDER_ID, SESSION_TOKEN } from "./test-den.ts"
import type { Fetch } from "./den.ts"

// The hub is process-wide, so each test uses its own organization.
let orgs = 0
const sessionFor = () => ({ apiBaseUrl: API, token: SESSION_TOKEN, orgId: `org_shared_fetch_${++orgs}` })

/** A fake Den whose responses wait until the test releases them. */
function gatedDen() {
  const den = createFakeDen()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const fetch: Fetch = async (url, init) => {
    await gate
    return den.fetch(url, init)
  }
  return { den, fetch, release }
}

const lists = (calls: readonly string[]) => calls.filter((call) => call.includes("?scope=usable")).length

test("Locations that ask together share one inventory fetch", async () => {
  const session = sessionFor()
  const { den, fetch, release } = gatedDen()
  const requests = Array.from({ length: 5 }, () =>
    fetchSharedGatewayInventory({ fetch, session, scope: "den", requestedAt: 1_000, now: () => 1_000 }))
  release()
  const inventories = await Promise.all(requests)
  assert.equal(lists(den.calls), 1)
  assert.deepEqual(den.calls, ["GET /v1/inference-providers?scope=usable", `GET /v1/inference-providers/${PROVIDER_ID}/connect`])
  for (const inventory of inventories) {
    assert.equal(inventory.apiKey, GATEWAY_KEY)
    assert.deepEqual(inventory.providers.map((provider) => provider.id), [PROVIDER_ID])
  }
})

test("a Location that asks after a fetch started gets its own fetch", async () => {
  const session = sessionFor()
  const { den, fetch, release } = gatedDen()
  const first = fetchSharedGatewayInventory({ fetch, session, scope: "den", requestedAt: 1_000, now: () => 1_000 })
  // A change arrived after the first fetch began reading Den.
  const later = fetchSharedGatewayInventory({ fetch, session, scope: "den", requestedAt: 1_001, now: () => 1_001 })
  release()
  await Promise.all([first, later])
  assert.equal(lists(den.calls), 2)
})

test("a finished fetch is reused only by Locations that asked before it started", async () => {
  const session = sessionFor()
  const den = createFakeDen()
  await fetchSharedGatewayInventory({ fetch: den.fetch, session, scope: "den", requestedAt: 1_000, now: () => 1_000 })
  await fetchSharedGatewayInventory({ fetch: den.fetch, session, scope: "den", requestedAt: 999, now: () => 1_010 })
  assert.equal(lists(den.calls), 1, "a slow Location that asked before the fetch started reuses it")
  await fetchSharedGatewayInventory({ fetch: den.fetch, session, scope: "den", requestedAt: 1_020, now: () => 1_020 })
  assert.equal(lists(den.calls), 2, "a later request reads Den again")
})

test("different credentials or credential scopes never share a fetch", async () => {
  const session = sessionFor()
  const den = createFakeDen()
  await Promise.all([
    fetchSharedGatewayInventory({ fetch: den.fetch, session, scope: "den", requestedAt: 1_000, now: () => 1_000 }),
    fetchSharedGatewayInventory({ fetch: den.fetch, session: { ...session, orgId: `${session.orgId}_other` }, scope: "den", requestedAt: 1_000, now: () => 1_000 }),
    fetchSharedGatewayInventory({ fetch: den.fetch, session, scope: "desktop", requestedAt: 1_000, now: () => 1_000 }),
  ])
  assert.equal(lists(den.calls), 3)
})

test("one Location giving up does not cancel the fetch the others are waiting for", async () => {
  const session = sessionFor()
  const { den, fetch, release } = gatedDen()
  const leaving = new AbortController()
  const gone = fetchSharedGatewayInventory({ fetch, session, scope: "den", requestedAt: 1_000, signal: leaving.signal, now: () => 1_000 })
  const staying = fetchSharedGatewayInventory({ fetch, session, scope: "den", requestedAt: 1_000, now: () => 1_000 })
  leaving.abort()
  await assert.rejects(gone)
  release()
  assert.equal((await staying).apiKey, GATEWAY_KEY)
  assert.equal(lists(den.calls), 1)
})

test("a failed fetch is not handed to the next Location", async () => {
  const session = sessionFor()
  const den = createFakeDen()
  let failNext = true
  const fetch: Fetch = async (url, init) => {
    if (failNext) { failNext = false; return new Response("unavailable", { status: 503 }) }
    return den.fetch(url, init)
  }
  await assert.rejects(fetchSharedGatewayInventory({ fetch, session, scope: "den", requestedAt: 1_000, now: () => 1_000 }))
  const retried = await fetchSharedGatewayInventory({ fetch, session, scope: "den", requestedAt: 999, now: () => 1_001 })
  assert.equal(retried.apiKey, GATEWAY_KEY)
})
