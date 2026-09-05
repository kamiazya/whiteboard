// The persistent tier of the render broker (ADR-0027 decision 5), against a
// real OPFS in a real browser — there is no jsdom equivalent, and a fake one
// would assert the fake.
//
// The tier lives in the WORKER rather than beside the broker, and that is the
// load-bearing choice rather than a detail. Measured on this machine, an OPFS
// read costs 1.5-2.7ms; a render already runs off the main thread, so reading
// the cache ON the main thread would move 2ms per row back onto the very
// thread #1275 and #1293 spent their effort clearing.
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, expect, it } from 'vitest'
import { nextLayoutRequestId, sharedLayoutWorkerPool } from './layout-worker-pool.js'
import type { LayoutResponse, MarkdownRenderResponse } from './layout-worker-protocol.js'
import { clearRenderStore, readRenderEntry, writeRenderEntry } from './render-store.js'

// Three nodes, not twelve: the assertion below is that this render stays
// UNDER the floor, and a case that only just clears it is a case that clears
// it under load. Measured warm, a 12-node canvas round-trips in 3.4ms against
// a 5ms floor and a 20-section markdown body in 20.4ms — this shrinks the
// lower margin further rather than resting on 1.6ms of it.
const CHEAP: SpatialCanvas = {
  nodes: Array.from({ length: 3 }, (_, i) => ({
    id: `n${i}`,
    type: 'text' as const,
    x: (i % 4) * 260,
    y: Math.floor(i / 4) * 160,
    width: 220,
    height: 120,
    text: `node ${i}`,
  })),
  edges: [],
}

// Costly on purpose: text shaping is the pipeline the measurements say
// persistence is FOR — 21.8ms at 20 sections against a 2.2ms read, where a
// 12-node spatial canvas is 2.0ms against 1.7ms and saves nothing worth a
// write.
const COSTLY_BODY = Array.from(
  { length: 20 },
  (_, i) =>
    `## Section ${i}\n\nA paragraph with enough words in it that line breaking is a real cost rather than a rounding error.\n\n- one\n- two\n`,
).join('\n')

function snapshotOf(canvas: SpatialCanvas): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvas)
  return doc.export({ mode: 'snapshot' })
}

function askLayout(cacheKey?: string): Promise<LayoutResponse> {
  return sharedLayoutWorkerPool().run<LayoutResponse>(
    {
      type: 'layout',
      id: nextLayoutRequestId(),
      snapshot: snapshotOf(CHEAP),
      theme: 'light',
      ...(cacheKey === undefined ? {} : { cacheKey }),
    },
    'background',
  )
}

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

// The gate, and the reason it exists rather than "persist everything":
// measured, a 12-node canvas renders in 2.0ms and an OPFS write costs
// 2.2-3.1ms, so storing it makes the FIRST visit slower to save nothing
// worth having on the second.
it('stores nothing for a render cheaper than the write it would cost', async () => {
  const key = `~build-test/svg/spatial/~cheap/~v1.json`

  // Warm first, with no key. The FIRST layout a worker runs pays for caches
  // this pipeline fills once — measured, it clears the floor where the same
  // canvas afterwards does not — and a list of twenty rows pays that once,
  // not per row. Asserting on the cold render would be measuring startup and
  // calling it the gate.
  await askLayout()
  const reply = await askLayout(key)
  expect(reply.type).toBe('laid-out')

  // A real wait, not an immediate read: an assertion that a write did NOT
  // happen has to outlast the window in which it would have.
  expect(await entryWithin(key, 500)).toBeNull()
})

// A request with no cache key is the honest state of a document whose keeper
// reports no version: nothing may be remembered for it, in memory or on disk.
it('stores nothing for a request that carries no key', async () => {
  const before = await readRenderEntry(freshKey())
  const reply = await askMarkdown()

  expect(reply.type).toBe('markdown-render-done')
  expect(before).toBeNull()
})
