import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { boxContains, topmostHit, topmostNodeAt } from './hit-test.js'

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

describe('topmostHit', () => {
  it('prefers a content node over a frame under the same point, wherever each sits in the list', () => {
    const boxes = [
      { id: 'member', box: box(10, 10, 20, 20) },
      { id: 'frame', container: true, box: box(0, 0, 100, 100) },
    ]
    expect(topmostHit(boxes, { x: 15, y: 15 })).toBe('member')
  })

  it('answers the innermost frame, the later in paint order, where no content sits', () => {
    const boxes = [
      { id: 'outer', container: true, box: box(0, 0, 200, 200) },
      { id: 'inner', container: true, box: box(10, 10, 50, 50) },
    ]
    expect(topmostHit(boxes, { x: 20, y: 20 })).toBe('inner')
    expect(topmostHit(boxes, { x: 150, y: 150 })).toBe('outer')
  })

  it('counts a point exactly on the border as a hit and answers nothing in empty space', () => {
    const boxes = [{ id: 'a', box: box(0, 0, 10, 10) }]
    expect(topmostHit(boxes, { x: 10, y: 10 })).toBe('a')
    expect(topmostHit(boxes, { x: 11, y: 10 })).toBeUndefined()
  })
})

describe('boxContains', () => {
  const edged = box(10, 20, 30, 40)

  it('counts the left and top edges as inside, like the right and bottom', () => {
    expect(boxContains(edged, { x: 10, y: 30 })).toBe(true)
    expect(boxContains(edged, { x: 20, y: 20 })).toBe(true)
    expect(boxContains(edged, { x: 10, y: 20 })).toBe(true)
  })

  it('misses a point just outside the near edges', () => {
    expect(boxContains(edged, { x: 9, y: 30 })).toBe(false)
    expect(boxContains(edged, { x: 20, y: 19 })).toBe(false)
  })
})

describe('topmostNodeAt', () => {
  const frame = groupNode({ id: 'frame', x: 0, y: 0, width: 400, height: 300 })
  const member = textNode({ id: 'a', x: 90, y: 50, width: 40, height: 30, text: '' })

  it('names the member whichever of the two the document stores first', () => {
    for (const nodes of [
      [frame, member],
      [member, frame],
    ]) {
      expect(topmostNodeAt(nodes, { x: 100, y: 60 })?.id).toBe('a')
    }
  })

  it('names the frame in its padding and nothing outside it', () => {
    expect(topmostNodeAt([member, frame], { x: 300, y: 200 })?.id).toBe('frame')
    expect(topmostNodeAt([member, frame], { x: 500, y: 500 })).toBeUndefined()
  })
})

describe('topmostNodeAt with nested frames', () => {
  // The ids sort against the nesting, so a scan in stored order names the
  // wrong frame whichever way the document happens to list them.
  const outer = groupNode({ id: 'z-outer', x: 0, y: 0, width: 400, height: 300 })
  const inner = groupNode({ id: 'a-inner', x: 50, y: 50, width: 150, height: 100 })
  const bothStoredOrders = [
    [outer, inner],
    [inner, outer],
  ]

  it('names the innermost frame whichever of the two the document stores first', () => {
    for (const nodes of bothStoredOrders) {
      expect(topmostNodeAt(nodes, { x: 60, y: 60 })?.id).toBe('a-inner')
    }
  })

  it('names the outer frame in its own padding', () => {
    for (const nodes of bothStoredOrders) {
      expect(topmostNodeAt(nodes, { x: 350, y: 250 })?.id).toBe('z-outer')
    }
  })

  it('names a member over both frames', () => {
    const member = textNode({ id: 'm', x: 60, y: 60, width: 20, height: 20, text: '' })
    expect(topmostNodeAt([member, inner, outer], { x: 65, y: 65 })?.id).toBe('m')
  })
})
