// @vitest-environment node
/**
 * The wire's whole claim is that everything on it is structured-cloneable
 * and that the layout drawn over the seams rebuilt from it is the one the
 * original wire draws.
 * A field that is a function would throw in `structuredClone` — which is
 * exactly the failure a real `postMessage` would raise, and the one this
 * file exists to catch before a worker does.
 */

import {
  constantRatioMeasureText,
  createSpatialTheme,
  layoutSpatialCanvas,
  referenceSeamsFromWire,
  referenceWire,
} from '@kamiazya/whiteboard-canvas-render'
import { testLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils/node-core'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import type { LayoutRequest } from './layout-worker-protocol.js'

const NOTE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 100, height: 60, text: `see ![[${NOTE_ID}]]` }),
    fileNode({ id: 'f', x: 200, y: 0, width: 100, height: 60, file: 'doc-1' }),
  ],
  edges: [],
}

describe('LayoutRequest', () => {
  it('carries the reference bundle as data that survives structuredClone and rebuilds the same seams', () => {
    const wire = referenceWire(
      new Map([
        [NOTE_ID, { documentId: NOTE_ID, name: 'Note', body: '# From the note' }],
        ['doc-1', { canvas: { nodes: [], edges: [] } }],
      ]),
      {
        resolveTitle: (id) => (id === NOTE_ID ? 'Note' : undefined),
        extras: new Map([['doc-1', { label: 'Doc one' }]]),
      },
    )
    const request: LayoutRequest = {
      type: 'layout',
      id: 1,
      canvas,
      theme: 'light',
      references: wire,
      expandedFileIds: ['f'],
    }
    const crossed = structuredClone(request)
    expect(crossed).toEqual(request)

    const seams = referenceSeamsFromWire(crossed.references as typeof wire)
    expect(seams.resolveTitle(NOTE_ID)).toBe('Note')
    // Roomy nodes, so the note's prose is not cut to a few characters.
    const roomy: SpatialCanvas = {
      ...canvas,
      nodes: canvas.nodes.map((node) => ({ ...node, width: 400, height: 300 })),
    }
    const draw = (references: typeof seams) =>
      JSON.stringify(
        layoutSpatialCanvas(roomy, {
          core: testLayoutCore(),
          measure: constantRatioMeasureText,
          appearance: createSpatialTheme({ mode: 'light' }),
          expandFileNode: () => true,
          references,
        }),
      )
    const drawn = draw(seams)
    expect(drawn).toBe(draw(referenceSeamsFromWire(wire)))
    // The embed mixed into prose stays a link run, labelled with the title.
    expect(drawn).toContain('"text":"Note"')
    // An empty canvas is a card for a file node, with the surface's label.
    expect(drawn).toContain('Doc one')
  })

  it('never names a stored reply on a keyed request, which the store could answer only in the plain form', () => {
    const plain: LayoutRequest = { type: 'layout', id: 1, canvas, theme: 'light', cacheKey: 'k' }
    const keyed: LayoutRequest = { type: 'layout', id: 2, canvas, theme: 'light', form: 'keyed' }
    // @ts-expect-error a keyed request may not carry a cache key
    const both: LayoutRequest = { ...keyed, cacheKey: 'k' }
    expect([plain.cacheKey, keyed.cacheKey, both.form]).toEqual(['k', undefined, 'keyed'])
  })
})
