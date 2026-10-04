import { describe, expect, it } from 'vitest'
import { frameHolds, membersOf } from './spatial.js'
import { groupNode, textNode } from './test-utils/nodes.js'

const frame = groupNode({ id: 'frame', x: 0, y: 0, width: 100, height: 100 })

describe('frameHolds', () => {
  it('holds a node strictly inside', () => {
    expect(frameHolds(frame, { x: 10, y: 10, width: 20, height: 20 })).toBe(true)
  })

  it('holds a node flush with every edge of the frame, since the rule is edge-inclusive', () => {
    expect(frameHolds(frame, { x: 0, y: 0, width: 100, height: 100 })).toBe(true)
  })

  it('does not hold a node that overhangs any one side by a unit', () => {
    expect(frameHolds(frame, { x: -1, y: 0, width: 10, height: 10 })).toBe(false)
    expect(frameHolds(frame, { x: 0, y: -1, width: 10, height: 10 })).toBe(false)
    expect(frameHolds(frame, { x: 91, y: 0, width: 10, height: 10 })).toBe(false)
    expect(frameHolds(frame, { x: 0, y: 91, width: 10, height: 10 })).toBe(false)
  })

  it('does not hold a node that only overlaps', () => {
    expect(frameHolds(frame, { x: 50, y: 50, width: 100, height: 100 })).toBe(false)
  })
})

describe('membersOf', () => {
  it('lists what a frame holds in the order given, without the frame itself', () => {
    const a = textNode({ id: 'a', x: 10, y: 10, width: 10, height: 10, text: '' })
    const outside = textNode({ id: 'out', x: 200, y: 0, width: 10, height: 10, text: '' })
    const b = textNode({ id: 'b', x: 0, y: 0, width: 5, height: 5, text: '' })
    expect(membersOf([b, frame, outside, a], frame).map((node) => node.id)).toEqual(['b', 'a'])
  })

  it('excludes a node by id, so a different node with the same box is still a member', () => {
    const twin = textNode({ id: 'twin', x: 0, y: 0, width: 100, height: 100, text: '' })
    expect(membersOf([frame, twin], frame).map((node) => node.id)).toEqual(['twin'])
  })
})
