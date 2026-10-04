import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { topmostHit, topmostNodeAt } from './hit-test.js'

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
