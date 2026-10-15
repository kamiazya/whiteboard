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
import { createSharedSseStreamSource, sharedStreamFailed } from './sse-shared-stream-source.js'

const RealSharedWorker = globalThis.SharedWorker

afterEach(() => {
  globalThis.SharedWorker = RealSharedWorker
})

it('a missing worker chunk rejects the read and falls back', async () => {
  globalThis.SharedWorker = class extends RealSharedWorker {
    constructor(_url: string | URL, options?: string | WorkerOptions) {
      super(new URL('/no-such-sse-worker-chunk.js', location.href), options)
    }
  }
  const origin = 'http://missing-chunk.test'
  const source = createSharedSseStreamSource(origin)
  expect(source).not.toBeNull()

  await expect(source?.snapshot('workspace:w')).rejects.toThrow()
  expect(sharedStreamFailed(origin)).toBe(true)
  expect(createSharedSseStreamSource(origin)).toBeNull()
})
