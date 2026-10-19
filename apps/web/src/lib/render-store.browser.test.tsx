// The persistent tier of the render broker (ADR-0027 decision 5), against a
// real OPFS in a real browser — there is no jsdom equivalent, and a fake one
// would assert the fake.
//
// The tier lives in the WORKER rather than beside the broker, and that is the
// load-bearing choice rather than a detail. Measured on this machine, an OPFS
// read costs 1.5-2.7ms; a render already runs off the main thread, so reading
// the cache ON the main thread would move 2ms per row back onto the very
// thread the worker pool exists to keep clear.
import { beforeEach, expect, it } from 'vitest'
import { nextLayoutRequestId, sharedLayoutWorkerPool } from './layout-worker-pool.js'
import type { MarkdownRenderResponse } from './layout-worker-protocol.js'
import { clearRenderStoreForTests, readRenderEntry, writeRenderEntry } from './render-store.js'

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
  return sharedLayoutWorkerPool().run(
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
  await clearRenderStoreForTests()
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

// The write-time build sweep (ADR-0027 decision 5) is one of the persistent
// tier's two evictions, so it is pinned against the store directly: an entry the old
// build left must be gone once a new build stores its first one, or every
// deploy keeps its whole cache in the origin's quota.
it('a new build storing its first entry removes the previous build’s entries', async () => {
  const oldKey = '~build-old/svg/markdown/~doc/~v1.json'
  const newKey = '~build-new/svg/markdown/~doc/~v1.json'
  await writeRenderEntry(oldKey, { from: 'old' })
  expect(await readRenderEntry(oldKey)).toEqual({ from: 'old' })

  await writeRenderEntry(newKey, { from: 'new' })

  expect(await readRenderEntry(newKey)).toEqual({ from: 'new' })
  expect(await readRenderEntry(oldKey)).toBeNull()
})

// A document's content digest is its leaf, so every edit names a new file.
// Another member typing into a shared note would otherwise leave one entry
// per version in this origin's quota — the quota the browser keeper's own
// IndexedDB shares — so a write keeps only the entry it just stored.
it('keeps one stored entry per document, the latest', async () => {
  const docDir = ['~build-test', 'svg', 'markdown', '~edited']
  const keyFor = (v: number): string => `${docDir.join('/')}/~v${v}.json`
  for (let v = 0; v < 6; v++) await writeRenderEntry(keyFor(v), { v })
  const neighbour = '~build-test/svg/markdown/~other/~v0.json'
  await writeRenderEntry(neighbour, { other: true })

  let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('render')
  for (const segment of docDir) dir = await dir.getDirectoryHandle(segment)
  const names: string[] = []
  for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
    names.push(name)
  }

  expect(names).toEqual(['~v5.json'])
  expect(await readRenderEntry(keyFor(5))).toEqual({ v: 5 })
  expect(await readRenderEntry(keyFor(4))).toBeNull()
  expect(await readRenderEntry(neighbour), 'another document lost its entry').toEqual({
    other: true,
  })
})

// A request with no cache key is the honest state of a document whose keeper
// reports no version: nothing may be remembered for it, in memory or on disk.
it('stores nothing for a request that carries no key', async () => {
  const before = await readRenderEntry(freshKey())
  const reply = await askMarkdown()

  expect(reply.type).toBe('markdown-render-done')
  expect(before).toBeNull()
})
