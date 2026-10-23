import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { edgeA11yName, nodeA11yName } from './node-a11y-name.js'

describe('node accessible names', () => {
  it('a note is named by its first line without markdown marks', () => {
    expect(
      nodeA11yName(
        textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text: '## **Review**\nmore' }),
      ),
    ).toBe('Review')
  })

  it('an empty note says so rather than leaving no name', () => {
    expect(nodeA11yName(textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text: '' }))).toBe(
      'Empty note',
    )
  })

  it('a long first line is clipped', () => {
    const name = nodeA11yName(
      textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text: 'x'.repeat(200) }),
    )
    expect(name.length).toBeLessThanOrEqual(60)
  })

  it('a frame says it is one, with its label when it has one', () => {
    expect(
      nodeA11yName(groupNode({ id: 'g', x: 0, y: 0, width: 100, height: 100, label: 'Phase 1' })),
    ).toBe('Frame Phase 1')
    expect(nodeA11yName(groupNode({ id: 'g', x: 0, y: 0, width: 100, height: 100 }))).toBe('Frame')
  })

  it('an edge reads from one end to the other, then its label', () => {
    const nodes: SpatialNode[] = [
      textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text: 'A' }),
      textNode({ id: 'b', x: 0, y: 0, width: 100, height: 40, text: 'B' }),
    ]
    const edge = { id: 'e', from: { node: 'a' }, to: { node: 'b' } } as const
    expect(edgeA11yName(edge, nodes)).toBe('Edge from A to B')
    expect(edgeA11yName({ ...edge, label: 'yes' }, nodes)).toBe('Edge from A to B: yes')
  })
})
