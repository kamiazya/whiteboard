// The worker answers a document's OUTLINE — the rectangles a tree row's icon
// and the tab favicon draw — for all three shapes a caller can hold it in.
//
// One request rather than a shape per surface, because the two surfaces
// differ only in where the document came from: the tree row has stored bytes,
// the favicon has the live canvas the editor is editing. A pipeline that
// forked there is how markdown fell out of the SVG family in the first place.
//
// A real browser, not jsdom: the subject is the worker, the loro-crdt WASM it
// imports lazily for the snapshot arm, and the font gate in front of the
// markdown arm — a body measured with a system face lays its blocks out
// somewhere else.
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { expect, it } from 'vitest'
import { nextLayoutRequestId, sharedLayoutWorkerPool } from './layout-worker-pool.js'
import type { OutlineResponse } from './layout-worker-protocol.js'

const canvas: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 220, height: 120, text: 'first node' },
    { id: 'b', type: 'text', x: 400, y: 220, width: 220, height: 120, text: 'second node' },
  ],
  edges: [],
}

function snapshotOf(value: SpatialCanvas): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, value)
  return doc.export({ mode: 'snapshot' })
}

function ask(request: Record<string, unknown>): Promise<OutlineResponse> {
  return sharedLayoutWorkerPool().run<OutlineResponse>(
    { type: 'outline', id: nextLayoutRequestId(), ...request },
    'idle',
  )
}

// The tree row's shape: only the stored bytes, handed over undecoded. The
// decode this replaces ran on the main thread, at the cost the snapshot
// handover measured — 1.20ms at 12 nodes, 2.60 at 40, 4.60 at 120 — once per
// visible row.
it('outlines a spatial document from its snapshot bytes, decoding inside the worker', async () => {
  const reply = await ask({ snapshot: snapshotOf(canvas) })

  expect(reply.type).toBe('outlined')
  if (reply.type !== 'outlined') return
  // Both nodes survived the decode, at the geometry the canvas declared — so
  // this is the real document's shape rather than an empty canvas's.
  expect(reply.rects).toHaveLength(2)
  expect(reply.rects.map((r) => r.w)).toEqual([220, 220])
  expect(reply.rects[1]?.x).toBe(400)
})

// The favicon's shape: the page already holds the live canvas, so exporting a
// snapshot just to post it would be strictly worse for that caller.
it('outlines a spatial canvas passed directly, for the page that already holds one', async () => {
  const reply = await ask({ canvas })

  expect(reply.type).toBe('outlined')
  if (reply.type !== 'outlined') return
  expect(reply.rects).toHaveLength(2)
})

// Both shapes describe the same document, so they must describe it the same
// way. A snapshot arm that disagreed with the live arm would make a tree row
// and the tab icon draw different pictures of one document.
it('answers the same rectangles whether it was handed the bytes or the canvas', async () => {
  const [fromBytes, fromCanvas] = await Promise.all([
    ask({ snapshot: snapshotOf(canvas) }),
    ask({ canvas }),
  ])

  expect(fromBytes.type).toBe('outlined')
  expect(fromCanvas.type).toBe('outlined')
  if (fromBytes.type !== 'outlined' || fromCanvas.type !== 'outlined') return
  expect(fromBytes.rects).toEqual(fromCanvas.rects)
})

// A markdown document has no boxes of its own, so its shape is the shape its
// blocks take once laid out — the one arm that needs a real layout pass, and
// the reason the font gate is in front of this request at all.
it('outlines a markdown body by laying its blocks out', async () => {
  const reply = await ask({ body: '# Heading\n\nA paragraph of text.\n', maxWidth: 640 })

  expect(reply.type).toBe('outlined')
  if (reply.type !== 'outlined') return
  expect(reply.rects.length).toBeGreaterThan(0)
  expect(reply.rects.every((r) => r.w > 0 && r.h > 0)).toBe(true)
})

// The bytes come from a keeper, so a corrupt snapshot is a real case: the row
// keeps its kind icon and the tab keeps its static one, rather than the
// worker going down for every request behind it.
it('answers failed for bytes that will not decode', async () => {
  const reply = await ask({ snapshot: new Uint8Array([1, 2, 3, 4, 5]) })

  expect(reply.type).toBe('failed')
})
