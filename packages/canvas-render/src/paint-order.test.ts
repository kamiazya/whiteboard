import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { paintOrderOf } from './paint-order.js'

const ids = (nodes: readonly { readonly id: string }[]) => nodes.map((node) => node.id)

describe('paintOrderOf', () => {
  it('paints a group before a member the canvas lists ahead of it', () => {
    // A map's id order put `a-member` first; the group must still go behind it.
    const member = textNode({ id: 'a-member', x: 40, y: 40, width: 120, height: 60, text: 'in' })
    const group = groupNode({ id: 'z-group', x: 0, y: 0, width: 300, height: 200, color: '5' })
    expect(ids(paintOrderOf([member, group]))).toEqual(['z-group', 'a-member'])
  })

  it('paints a larger group before a smaller one, and equal groups in stored order', () => {
    const inner = groupNode({ id: 'inner', x: 10, y: 10, width: 100, height: 100 })
    const outer = groupNode({ id: 'outer', x: 0, y: 0, width: 400, height: 400 })
    const twinA = groupNode({ id: 'twin-a', x: 500, y: 0, width: 100, height: 100 })
    expect(ids(paintOrderOf([inner, twinA, outer]))).toEqual(['outer', 'inner', 'twin-a'])
  })

  it('keeps every other node in stored order after the groups', () => {
    const b = textNode({ id: 'b', x: 0, y: 0, width: 10, height: 10, text: 'b' })
    const a = textNode({ id: 'a', x: 20, y: 0, width: 10, height: 10, text: 'a' })
    const group = groupNode({ id: 'g', x: 0, y: 0, width: 10, height: 10 })
    expect(ids(paintOrderOf([b, group, a]))).toEqual(['g', 'b', 'a'])
  })
})
