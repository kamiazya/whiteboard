// The worker can be handed a document's SNAPSHOT BYTES instead of a decoded
// canvas, and decodes them itself.
//
// Why it matters, measured before building: decoding on the main thread cost
// 1.20ms at 12 nodes, 2.60ms at 40 and 4.60ms at 120 — an order of magnitude
// more than the structured clone it was blamed on (0.10 / 0.10 / 0.40ms, and
// unmeasurable for the bytes). A list of twenty visible rows therefore spent
// 24-92ms of the thread that answers the user, purely to hand work to a
// worker that could have done it.
//
// A real browser, not jsdom: the subject is the worker, its lazily imported
// loro-crdt WASM, and the real font gate in front of both.
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { expect, it } from 'vitest'
import { nextLayoutRequestId, sharedLayoutWorkerPool } from './layout-worker-pool.js'
import type { LayoutResponse } from './layout-worker-protocol.js'

const canvas: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 220, height: 120, text: 'first node' },
    { id: 'b', type: 'text', x: 400, y: 220, width: 220, height: 120, text: 'second node' },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
}

function snapshotOf(value: SpatialCanvas): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, value)
  return doc.export({ mode: 'snapshot' })
}

/**
 * One worker, addressed directly rather than through the shared pool.
 *
 * The pool holds up to four workers, so two requests sent through it may
 * land on two different ones — which answers "the pool still has a healthy
 * worker", a claim that would hold even if the corrupt snapshot had killed
 * the one that read it. The subject here is that worker, so the test has to
 * be the one choosing it.
 */
function askOneWorker(
  worker: Worker,
  request: { readonly id: number } & Record<string, unknown>,
): Promise<LayoutResponse> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<LayoutResponse>) => {
      if (event.data.id !== request.id) return
      worker.removeEventListener('message', onMessage)
      resolve(event.data)
    }
    worker.addEventListener('message', onMessage)
    // A worker whose module failed to load fires this once and never posts,
    // so without it a load failure arrives as a timeout naming the test.
    worker.addEventListener('error', () => reject(new Error('layout worker errored')), {
      once: true,
    })
    worker.postMessage(request)
  })
}

it('lays out a canvas from its snapshot bytes, decoding inside the worker', async () => {
  const reply = await sharedLayoutWorkerPool().run<LayoutResponse>({
    type: 'layout',
    id: nextLayoutRequestId(),
    snapshot: snapshotOf(canvas),
    theme: 'light',
  })

  expect(reply.type).toBe('laid-out')
  if (reply.type !== 'laid-out') return
  expect(reply.svg.startsWith('<svg')).toBe(true)
  // Both nodes and the edge between them survived the decode, so this is a
  // layout of the real document rather than of an empty canvas.
  expect(reply.svg).toContain('first node')
  expect(reply.svg).toContain('second node')
  expect(reply.bounds.w).toBeGreaterThan(400)
}, 30_000)

// The bytes come from a keeper, so a corrupt snapshot is a real case. It must
// come back as a `failed` reply — the row then keeps its kind icon — rather
// than taking the worker down for every request behind it.
//
// Both requests go to ONE worker on purpose: it is the worker that read the
// corrupt bytes whose survival is in question, and the pool would be free to
// answer the second one from a different worker that never saw them.
it('answers failed for bytes that will not decode, and the same worker serves the next request', async () => {
  const worker = new Worker(new URL('./layout-worker.ts', import.meta.url), { type: 'module' })
  try {
    const refused = await askOneWorker(worker, {
      type: 'layout',
      id: nextLayoutRequestId(),
      snapshot: new Uint8Array([1, 2, 3, 4, 5]),
      theme: 'light',
    })
    expect(refused.type).toBe('failed')

    const after = await askOneWorker(worker, {
      type: 'layout',
      id: nextLayoutRequestId(),
      snapshot: snapshotOf(canvas),
      theme: 'light',
    })
    expect(after.type).toBe('laid-out')
  } finally {
    worker.terminate()
  }
}, 30_000)

// The editor still hands over a live canvas it already holds in memory:
// exporting a snapshot just to post it would be strictly worse for that
// caller. Both shapes have to keep working.
it('still lays out a canvas passed directly, for the editor that already holds one', async () => {
  const reply = await sharedLayoutWorkerPool().run<LayoutResponse>({
    type: 'layout',
    id: nextLayoutRequestId(),
    canvas,
    theme: 'light',
  })
  expect(reply.type).toBe('laid-out')
}, 30_000)
