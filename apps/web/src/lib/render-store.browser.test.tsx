// The persistent tier of the render broker (ADR-0027 decision 5), against a
// real OPFS in a real browser — there is no jsdom equivalent, and a fake one
// would assert the fake.
//
// The tier lives in the WORKER rather than beside the broker, and that is the
// load-bearing choice rather than a detail. Measured on this machine, an OPFS
// read costs 1.5-2.7ms; a render already runs off the main thread, so reading
// the cache ON the main thread would move 2ms per row back onto the very
// thread #1275 and #1293 spent their effort clearing.
import { beforeEach, expect, it } from 'vitest'
import { nextLayoutRequestId, sharedLayoutWorkerPool } from './layout-worker-pool.js'
import type { MarkdownRenderResponse } from './layout-worker-protocol.js'
import { clearRenderStore, readRenderEntry, writeRenderEntry } from './render-store.js'

// Costly on purpose: text shaping is the pipeline the measurements say
// persistence is FOR — 21.8ms at 20 sections against a 2.2ms read, where a
// 12-node spatial canvas is 2.0ms against 1.7ms and saves nothing worth a
// write.
const COSTLY_BODY = Array.from(
  { length: 20 },
  (_, i) =>
    `## Section ${i}\n\nA paragraph with enough words in it that line breaking is a real cost rather than a rounding error.\n\n- one\n- two\n`,
).join('\n')

function askMarkdown(cacheKey?: string): Promise<MarkdownRenderResponse> {
  return sharedLayoutWorkerPool().run<MarkdownRenderResponse>(
    {
      type: 'markdown-render',
      id: nextLayoutRequestId(),
      body: COSTLY_BODY,
      maxWidth: 640,
      ...(cacheKey === undefined ? {} : { cacheKey }),
    },
    'background',
  )
}

let seq = 0
const freshKey = (): string => `~build-test/svg/markdown/~doc${seq++}/~v1.json`

/**
 * The write is deliberately NOT awaited by the worker — a caller must never
 * wait on a cache — so an assertion that reads straight after the reply is
 * racing a side effect rather than checking one. Polling is what the contract
 * actually promises: the entry appears, shortly, or the write failed.
 */
async function entryWithin(key: string, ms: number): Promise<unknown | null> {
  const deadline = performance.now() + ms
  for (;;) {
    const found = await readRenderEntry(key)
    if (found !== null || performance.now() > deadline) return found
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

beforeEach(async () => {
  await clearRenderStore()
})

// The decisive one: what comes back is what the STORE held, not what the
// renderer would have produced. Seeding a value no renderer could invent is
// the only observation that separates "answered from the store" from
// "answered quickly".
it('answers a request from the stored entry rather than rendering again', async () => {
  const key = freshKey()
  await writeRenderEntry(key, {
    type: 'markdown-render-done',
    svg: '<svg data-seeded="only-the-store-could-say-this"></svg>',
    bounds: { x: 0, y: 0, w: 7, h: 11 },
  })

  const reply = await askMarkdown(key)

  expect(reply.type).toBe('markdown-render-done')
  if (reply.type !== 'markdown-render-done') return
  expect(reply.svg).toContain('only-the-store-could-say-this')
  expect(reply.bounds).toEqual({ x: 0, y: 0, w: 7, h: 11 })
})

// The reply still has to be answerable: a stored entry carries no id, so the
// worker has to stamp this request's own or the pool never settles the
// promise — which would look like a hang rather than a wrong picture.
it('stamps the asking request’s id onto a stored entry', async () => {
  const key = freshKey()
  await writeRenderEntry(key, {
    type: 'markdown-render-done',
    svg: '<svg/>',
    bounds: { x: 0, y: 0, w: 1, h: 1 },
  })

  // Two in a row through one pool: the second would be answered by the
  // first's id if the stamp were missing.
  await askMarkdown(key)
  const reply = await askMarkdown(key)
  expect(reply.type).toBe('markdown-render-done')
})

it('stores a render that cost more than storing it does', async () => {
  const key = freshKey()

  const reply = await askMarkdown(key)
  expect(reply.type).toBe('markdown-render-done')

  const stored = await entryWithin(key, 2000)
  expect(stored, 'a costly render left nothing behind for the next visit').not.toBeNull()
  expect((stored as { type?: string } | null)?.type).toBe('markdown-render-done')
})

// The cheap-render case is NOT here, and its absence is the point. It used to
// lay out three nodes and assert nothing was written, which made the test's
// premise "this machine lays out three nodes in under 5ms" — unestablishable
// from inside the test, and false on a loaded runner, where the production
// code then stores the render exactly as it should. Observed: shard 1 took 94s
// on one commit and 202s on the next, and this test passed then failed with no
// production change between them. The fixture had already been shrunk from
// twelve nodes to three to buy margin, which is treating the symptom.
//
// The claim lives in `render-store.test.ts` now, over `worthStoring` itself,
// where it is true on every machine, with a conformance check pinning that
// this worker is its caller. What stays in this file is what only a real
// browser can answer: that a COSTLY render survives the round trip into OPFS,
// and that a keyless request is never remembered.

// A request with no cache key is the honest state of a document whose keeper
// reports no version: nothing may be remembered for it, in memory or on disk.
it('stores nothing for a request that carries no key', async () => {
  const before = await readRenderEntry(freshKey())
  const reply = await askMarkdown()

  expect(reply.type).toBe('markdown-render-done')
  expect(before).toBeNull()
})
