/**
 * A SharedWorker whose module fails to load, in a real browser.
 *
 * The jsdom suite fires `onerror` by hand, which proves what the source does
 * with the event but not that a browser sends it: a module worker that fails
 * to load constructs fine, so the only evidence is the event itself. Pointed
 * at a module the dev server does not have, which is the shape of a chunk
 * missing from a deploy.
 */
import { afterEach, expect, it } from 'vitest'
import { createSharedSseStreamSource } from './sse-shared-stream-source.js'

const RealSharedWorker = globalThis.SharedWorker

afterEach(() => {
  globalThis.SharedWorker = RealSharedWorker
})

it('a missing worker chunk rejects the read and falls back', async () => {
  let constructed = 0
  globalThis.SharedWorker = class extends RealSharedWorker {
    constructor(_url: string | URL, options?: string | WorkerOptions) {
      super(new URL('/no-such-sse-worker-chunk.js', location.href), options)
      constructed += 1
    }
  }
  // The page's own read: the only daemon this origin has once the worker is gone.
  const pageFetch = (async () => new Response(new Uint8Array([4, 2]))) as typeof fetch
  // Cached per origin, failed worker included, so a repeated run takes its own.
  const origin = `http://missing-chunk-${crypto.randomUUID()}.test`
  const source = createSharedSseStreamSource(origin, pageFetch)
  expect(source).not.toBeNull()

  await expect(source?.snapshot('workspace:w')).rejects.toThrow()
  await expect(source?.snapshot('workspace:w')).resolves.toEqual(new Uint8Array([4, 2]))
  expect(createSharedSseStreamSource(origin, pageFetch)).toBe(source)
  expect(constructed).toBe(1)
})
