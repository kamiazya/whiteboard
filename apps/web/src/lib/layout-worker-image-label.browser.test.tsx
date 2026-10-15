// A Files row's picture of a board is drawn by the layout worker from the
// stored snapshot alone, with no image bytes resolved. An image node there is
// still a box with a label, and that label is what a reader sees of it — so it
// must name the node, never print the storage id behind it.
//
// A real browser, not jsdom: the subject is the worker the Files panel asks,
// with its lazily imported loro-crdt WASM and real font gate.

import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { expect, it } from 'vitest'
import { nextLayoutRequestId, sharedLayoutWorkerPool } from './layout-worker-pool.js'

const IMAGE_ONLY: SpatialCanvas = {
  nodes: [
    fileNode({
      id: 'pic',
      x: 0,
      y: 0,
      width: 320,
      height: 200,
      file: 'asset:0b9a6c1e-1111-4222-8333-444455556666',
    }),
  ],
  edges: [],
}

function snapshotOf(value: SpatialCanvas): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, value)
  return doc.export({ mode: 'snapshot' })
}

it('draws an image-only board for a Files row without its asset id', async () => {
  const reply = await sharedLayoutWorkerPool().run({
    type: 'layout',
    id: nextLayoutRequestId(),
    snapshot: snapshotOf(IMAGE_ONLY),
    theme: 'light',
  })

  expect(reply.type).toBe('laid-out')
  if (reply.type !== 'laid-out') return
  const drawn = new DOMParser().parseFromString(reply.svg, 'image/svg+xml')
  const text = drawn.documentElement.textContent ?? ''
  expect(text).toContain('Image')
  expect(text).not.toContain('asset:')
}, 30_000)
