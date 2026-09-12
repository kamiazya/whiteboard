/**
 * The spatial half of the row renderer, end to end in a real browser.
 *
 * The markdown half is covered by the worker parity test; this one exists
 * because nothing else exercises snapshot bytes → LoroDoc → the pool's
 * `layout` message → an SVG. Every piece is proven separately and the seam
 * between them is not, which is exactly where a wrong key or a stale message
 * kind hides.
 */

import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { expect, it } from 'vitest'
import { createInTabRenderBroker } from '../../lib/render-broker.js'
import { createRowRenderLoader } from './load-row-render.js'

const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 200, height: 120, text: 'Alpha' }),
    textNode({ id: 'b', x: 300, y: 60, width: 200, height: 120, text: 'Beta' }),
  ],
  edges: [
    {
      id: 'e1',
      from: { node: 'a' },
      to: { node: 'b' },
    },
  ],
} as SpatialCanvas

function snapshotBytes(): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvas)
  return doc.export({ mode: 'snapshot' })
}

it('renders a spatial document from its snapshot bytes through the pool', async () => {
  const bytes = snapshotBytes()
  const load = createRowRenderLoader({
    theme: 'light',
    broker: createInTabRenderBroker(),
    source: {
      listDocuments: async () => [],
      createDocument: async () => {},
      renameDocumentPath: async () => {},
      searchDocuments: async () => [],
      setDocumentName: async () => {},
      loadSpatialSnapshot: async () => bytes,
      loadMarkdown: async () => {
        throw new Error('a spatial document must not be read as OKF')
      },
    },
  })

  const drawn = await load({ documentId: 'd1', path: 'a/b', kind: 'spatial' })

  expect(drawn).not.toBeNull()
  // The text proves it drew THIS canvas, not an empty one — an empty scene
  // also produces a valid <svg> and would pass a shape-only assertion.
  expect(drawn?.svg).toContain('Alpha')
  expect(drawn?.svg).toContain('Beta')
  expect(drawn?.bounds.w).toBeGreaterThan(0)
}, 60_000)
