// What a file node's label says when its reference has not been resolved.
// An image reference (`asset:<uuid>`) is an opaque storage id, so a surface
// that lacks the bytes — a chat widget, an export, an offline replica — must
// name what the node IS rather than print that id.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import type { TextRunNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { renderSceneToSvg } from '../svg/backend.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { labelOf } from './node-box.js'
import { layoutSpatialCanvas, type SpatialLayoutOptions } from './spatial-canvas.js'

const IMAGE_REF = 'asset:0b9a6c1e-1111-4222-8333-444455556666'

const IMAGE_NODE = fileNode({ id: 'img', x: 0, y: 0, width: 320, height: 200, file: IMAGE_REF })

function options(over?: Partial<SpatialLayoutOptions>): SpatialLayoutOptions {
  return {
    measure: createFakeMeasure(),
    parseBody: () => ({ type: 'root', children: [] }),
    appearance: { resolveNode: () => ({}), resolveEdge: () => ({}), resolveLabel: () => ({}) },
    ...over,
  }
}

const labels = (canvas: SpatialCanvas, over?: Partial<SpatialLayoutOptions>): string[] =>
  layoutSpatialCanvas(canvas, options(over))
    .nodes.filter((n): n is TextRunNode => n.kind === 'textRun')
    .map((n) => n.text)

describe('labelOf an unresolved image reference', () => {
  it('reads "Image" with no resolver, so neither the scene nor the SVG carries the asset id', () => {
    const canvas: SpatialCanvas = { nodes: [IMAGE_NODE], edges: [] }
    expect(labels(canvas)).toEqual(['Image'])
    const scene = layoutSpatialCanvas(canvas, options())
    expect(renderSceneToSvg(scene)).not.toContain('asset:')
  })

  it('reads "Image" when the resolver knows nothing of the reference', () => {
    expect(labelOf(IMAGE_NODE, undefined)).toBe('Image')
    expect(labelOf(IMAGE_NODE, {})).toBe('Image')
  })

  it('prefers the alt text a resolution carries, and a resolved label over both', () => {
    expect(labelOf(IMAGE_NODE, { image: { href: '', alt: 'Architecture sketch' } })).toBe(
      'Architecture sketch',
    )
    expect(labelOf(IMAGE_NODE, { image: { href: '', alt: '' } })).toBe('Image')
    expect(labelOf(IMAGE_NODE, { label: 'diagram.png' })).toBe('diagram.png')
  })

  it('leaves a non-image reference on its existing raw-reference fallback', () => {
    const doc = fileNode({ id: 'd', x: 0, y: 0, width: 320, height: 40, file: 'notes/plan' })
    expect(labelOf(doc, undefined)).toBe('notes/plan')
  })
})
