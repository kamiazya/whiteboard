// @vitest-environment node

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { nodeText } from '@kamiazya/whiteboard-model'
import { linkNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { withNodeText } from './node-text.js'

const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'n1', x: 0, y: 0, width: 10, height: 10, text: 'before' }),
    linkNode({ id: 'n2', x: 0, y: 0, width: 10, height: 10, url: 'https://example.com' }),
  ],
  edges: [],
}

describe('withNodeText', () => {
  it('replaces the body of the named text node and leaves the rest alone', () => {
    const next = withNodeText(canvas, 'n1', 'after')
    const node = next.nodes.find((entry) => entry.id === 'n1')
    expect(node === undefined ? null : nodeText(node)).toBe('after')
    expect(next.nodes[1]).toBe(canvas.nodes[1])
    expect(next).not.toBe(canvas)
  })

  // The caller writes a revision only when something changed, so "nothing
  // changed" has to be recognisable — reference equality says it exactly.
  it('returns the same canvas when nothing would change', () => {
    expect(withNodeText(canvas, 'n1', 'before')).toBe(canvas)
    expect(withNodeText(canvas, 'missing', 'after')).toBe(canvas)
    expect(withNodeText(canvas, 'n2', 'after')).toBe(canvas)
  })
})
