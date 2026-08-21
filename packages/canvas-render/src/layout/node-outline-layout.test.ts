import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { outlineContains } from './node-outline.js'
import type { SpatialAppearanceResolver } from './spatial-appearance.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'

const appearance: SpatialAppearanceResolver = {
  resolveNode: () => ({}),
  resolveEdge: () => undefined,
  resolveLabel: () => ({}),
}

const canvas: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 60, text: '' },
    { id: 'b', type: 'text', x: 300, y: 200, width: 100, height: 60, text: '' },
    { id: 'c', type: 'text', x: -300, y: 200, width: 100, height: 60, text: '' },
  ],
  // Two edges into the same side fan their anchors out, so at least one
  // terminal sits OFF the side's midpoint — i.e. off the ellipse tangent —
  // which is what the pull-in has to move.
  edges: [
    { id: 'e', fromNode: 'b', toNode: 'a', toSide: 'bottom' as const },
    { id: 'e2', fromNode: 'c', toNode: 'a', toSide: 'bottom' as const },
  ],
}

const layout = (nodeOutlines?: Readonly<Record<string, 'ellipse'>>) =>
  layoutSpatialCanvas(canvas, { measure: createFakeMeasure(), appearance, nodeOutlines })

describe('nodeOutlines layout seam (plain data, worker-safe)', () => {
  it('threads the outline kind onto the chrome shape', () => {
    const scene = layout({ a: 'ellipse' })
    const chrome = scene.nodes.find((n) => n.kind === 'shape' && n.id === 'a')
    expect(chrome).toMatchObject({ shape: 'ellipse' })
    const plain = layout().nodes.find((n) => n.kind === 'shape' && n.id === 'a')
    expect(plain).not.toHaveProperty('shape')
  })

  it('pulls the edge terminal onto the outline rim instead of the bbox border', () => {
    const withOutline = layout({ a: 'ellipse' })
    const without = layout()
    const edgeOf = (scene: typeof withOutline) =>
      scene.nodes.find((n) => n.kind === 'edge' && n.id === 'e')
    const adjusted = edgeOf(withOutline)
    const baseline = edgeOf(without)
    if (adjusted?.kind !== 'edge' || baseline?.kind !== 'edge') throw new Error('edge missing')
    const last = adjusted.path[adjusted.path.length - 1]
    const baselineLast = baseline.path[baseline.path.length - 1]
    // The bbox-border terminal moved…
    expect(last).not.toEqual(baselineLast)
    // …onto the ellipse boundary (containment is boundary-inclusive).
    expect(outlineContains('ellipse', { x: 0, y: 0, w: 100, h: 60 }, last)).toBe(true)
    // The source node has no outline kind, so its end stays put.
    expect(adjusted.path[0]).toEqual(baseline.path[0])
  })
})
