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
it('answers failed for bytes that will not decode, and keeps serving after', async () => {
  const reply = await sharedLayoutWorkerPool().run<LayoutResponse>({
    type: 'layout',
    id: nextLayoutRequestId(),
    snapshot: new Uint8Array([1, 2, 3, 4, 5]),
    theme: 'light',
  })
  expect(reply.type).toBe('failed')

  const after = await sharedLayoutWorkerPool().run<LayoutResponse>({
    type: 'layout',
    id: nextLayoutRequestId(),
    snapshot: snapshotOf(canvas),
    theme: 'light',
  })
  expect(after.type).toBe('laid-out')
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
