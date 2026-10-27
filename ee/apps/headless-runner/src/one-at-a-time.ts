/**
 * Runs work for the same key one at a time, in the order it arrives. A conversation and its background tasks share one
 * computer screen, so their screen operations take turns instead of failing with "already running an operation". A
 * caller that is aborted while waiting gives up its place without running.
 */
export function oneAtATime() {
  const tails = new Map<string, Promise<void>>()
  return async function run<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const done = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => done)
    tails.set(key, tail)
    try {
      signal?.throwIfAborted()
      if (signal) {
        let stop: (() => void) | undefined
        const aborted = new Promise<never>((_, reject) => {
          stop = () => reject(signal.reason)
          signal.addEventListener("abort", stop, { once: true })
        })
        try { await Promise.race([previous, aborted]) } finally { if (stop) signal.removeEventListener("abort", stop) }
      } else await previous
      return await work()
    } finally {
      release()
      if (tails.get(key) === tail) tails.delete(key)
    }
  }
}
