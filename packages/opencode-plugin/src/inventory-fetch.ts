import { inventorySessionKey } from "./inventory-events.ts"
import { fetchGatewayInventory, type GatewayInventory } from "./providers.ts"
import type { DenSession, Fetch } from "./den.ts"

type CredentialScope = "den" | "desktop"

// A finished fetch is reused only by a Location that asked before it started,
// so this just bounds how long one is kept for Locations whose own setup was slow.
const SETTLED_REUSE_MS = 60_000

interface SharedFetch {
  readonly startedAt: number
  readonly controller: AbortController
  readonly result: Promise<GatewayInventory>
  joiners: number
  settledAt: number | null
  failed: boolean
}

interface InventoryFetchHub {
  readonly fetch: (request: SharedInventoryRequest) => Promise<GatewayInventory>
}

export interface SharedInventoryRequest {
  readonly fetch: Fetch
  readonly session: DenSession
  readonly scope: CredentialScope
  /** When this Location decided it needed fresh inventory. */
  readonly requestedAt: number
  readonly signal?: AbortSignal
  readonly now?: () => number
}

// OpenCode creates one plugin instance per Location, each in its own ESM graph,
// and one change on the shared inventory stream reaches all of them at once.
// Like the stream hub, only an immutable capability is global; fetches and the
// credentials they carry stay in this closure.
declare global {
  var __openworkGatewayInventoryFetches: InventoryFetchHub | undefined
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError")
}

function createInventoryFetchHub(): InventoryFetchHub {
  const shared = new Map<string, SharedFetch>()

  const start = (key: string, request: SharedInventoryRequest, now: number): SharedFetch => {
    const controller = new AbortController()
    const entry: SharedFetch = {
      startedAt: now,
      controller,
      joiners: 0,
      settledAt: null,
      failed: false,
      result: fetchGatewayInventory(request.fetch, request.session, controller.signal, request.scope),
    }
    entry.result.then(
      () => { entry.settledAt = (request.now ?? Date.now)() },
      () => {
        entry.failed = true
        entry.settledAt = (request.now ?? Date.now)()
        if (shared.get(key) === entry) shared.delete(key)
      },
    )
    shared.set(key, entry)
    return entry
  }

  const fetch = async (request: SharedInventoryRequest): Promise<GatewayInventory> => {
    if (request.signal?.aborted) throw abortError(request.signal)
    const now = (request.now ?? Date.now)()
    const key = `${inventorySessionKey(request.session)}:${request.scope}`
    let entry = shared.get(key)
    if (entry && entry.settledAt !== null && now - entry.settledAt > SETTLED_REUSE_MS) {
      shared.delete(key)
      entry = undefined
    }
    // Every event is authoritative: a Location only takes a fetch that began
    // after it asked, never one that may have read Den before its change.
    const usable = entry && !entry.failed && entry.startedAt >= request.requestedAt
    const current = usable && entry ? entry : start(key, request, now)
    current.joiners += 1
    const leave = () => {
      current.joiners -= 1
      if (current.joiners === 0 && current.settledAt === null) current.controller.abort()
    }
    const signal = request.signal
    if (!signal) {
      try { return await current.result } finally { leave() }
    }
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError(signal))
      signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      return await Promise.race([current.result, aborted])
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort)
      leave()
    }
  }

  return Object.freeze({ fetch: Object.freeze(fetch) })
}

/**
 * The gateway inventory for this session, fetched once for every Location that
 * asks at the same time. A Location never receives a fetch that started before
 * it asked, and aborting one Location's request leaves the others running.
 */
export function fetchSharedGatewayInventory(request: SharedInventoryRequest): Promise<GatewayInventory> {
  let hub = globalThis.__openworkGatewayInventoryFetches
  if (!hub) {
    hub = createInventoryFetchHub()
    Object.defineProperty(globalThis, "__openworkGatewayInventoryFetches", {
      value: hub,
      writable: false,
      configurable: false,
      enumerable: false,
    })
  }
  return hub.fetch(request)
}
