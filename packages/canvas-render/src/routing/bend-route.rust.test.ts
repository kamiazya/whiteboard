import type { CanvasEdge } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { routeEdge } from '../test-utils/wasm/edge-router.js'

describe('how a bent path is DRAWN', () => {
  const nodes = [
    textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'a' }),
    textNode({ id: 'b', x: 400, y: 300, width: 100, height: 50, text: 'b' }),
  ]
  const bent: CanvasEdge = {
    id: 'e',
    from: { node: 'a' },
    to: { node: 'b' },
    bends: [
      { x: 200, y: 20 },
      { x: 200, y: 320 },
    ],
  } as CanvasEdge

  it('rounds the corners of a CURVED element, the same as a computed route', () => {
    // The stored path answers WHERE the element goes; the style still says
    // how it is drawn, and the two are independent. Without this a freehand
    // stroke — a line that is all bends — came back as a chain of straight
    // segments with a visible corner at every sample the simplification
    // kept, which reads as a jagged stroke rather than a drawn one.
    expect(routeEdge(nodes, bent, 'curved', undefined).rounded).toBe(true)
  })

  it('leaves a straight element crisp', () => {
    // Waypoints somebody placed by hand on an ordinary edge are corners they
    // meant; only asking for `curved` softens them.
    expect(routeEdge(nodes, bent, 'straight', undefined).rounded).toBeUndefined()
  })
})
