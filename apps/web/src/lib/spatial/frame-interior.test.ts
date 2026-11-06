import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { expect, it } from 'vitest'
import {
  creationObstacles,
  frameForNewNote,
  frameTitleAt,
  nextSpotInFrame,
  pointInsideFrame,
} from './frame-interior.js'

const frame = groupNode({ id: 'g', x: 200, y: 200, width: 400, height: 300, label: 'Edge' })
const size = { width: 200, height: 100 }

it('the name strip is the frame width, from the label band down to the top edge', () => {
  expect(frameTitleAt([frame], { x: 300, y: 180 })).toBe('g')
  expect(frameTitleAt([frame], { x: 300, y: 157 })).toBe('g')
  expect(frameTitleAt([frame], { x: 700, y: 180 })).toBeUndefined()
  expect(frameTitleAt([frame], { x: 300, y: 155 })).toBeUndefined()
  expect(frameTitleAt([frame], { x: 300, y: 300 })).toBeUndefined()
})

it('a frame with no name has no strip, and a note is not a frame', () => {
  const unnamed = groupNode({ id: 'u', x: 200, y: 200, width: 400, height: 300 })
  const note = textNode({ id: 't', x: 200, y: 200, width: 400, height: 300, text: 'x' })
  expect(frameTitleAt([unnamed, note], { x: 300, y: 180 })).toBeUndefined()
})

it('a point near an edge moves in so the whole note stays inside the frame', () => {
  expect(pointInsideFrame(frame, { x: 210, y: 210 }, size)).toEqual({ x: 300, y: 250 })
  expect(pointInsideFrame(frame, { x: 590, y: 490 }, size)).toEqual({ x: 500, y: 450 })
  expect(pointInsideFrame(frame, { x: 400, y: 350 }, size)).toEqual({ x: 400, y: 350 })
})

it('a frame smaller than the note keeps the point it was given', () => {
  const small = groupNode({ id: 's', x: 0, y: 0, width: 100, height: 50 })
  expect(pointInsideFrame(small, { x: 30, y: 20 }, size)).toEqual({ x: 30, y: 20 })
})

it('the next spot in a frame is its first free cell, a margin clear of every member', () => {
  const empty = nextSpotInFrame(frame, [frame], size)
  // Top-left cell: the margin in from the frame's corner.
  expect(empty).toEqual({ center: { x: 332, y: 282 } })
  const first = textNode({ id: 'a', x: 232, y: 232, width: 200, height: 100, text: 'a' })
  // 400 wide holds one 200 column with 32 either side, so the next row.
  expect(nextSpotInFrame(frame, [frame, first], size)).toEqual({ center: { x: 332, y: 414 } })
})

it('a full frame grows down to take the next note', () => {
  const a = textNode({ id: 'a', x: 232, y: 232, width: 200, height: 100, text: 'a' })
  const b = textNode({ id: 'b', x: 232, y: 364, width: 200, height: 100, text: 'b' })
  expect(nextSpotInFrame(frame, [frame, a, b], size)).toEqual({
    center: { x: 332, y: 546 },
    grow: { x: 200, y: 200, width: 400, height: 428 },
  })
})

it('a full frame with a neighbour under it grows sideways, not into the neighbour', () => {
  const full = groupNode({ id: 'f', x: 200, y: 200, width: 264, height: 296, label: 'Now' })
  const a = textNode({ id: 'a', x: 232, y: 232, width: 200, height: 100, text: 'a' })
  const b = textNode({ id: 'b', x: 232, y: 364, width: 200, height: 100, text: 'b' })
  const below = groupNode({ id: 'n', x: 200, y: 560, width: 264, height: 200, label: 'Later' })
  expect(nextSpotInFrame(full, [full, a, b, below], size)).toEqual({
    center: { x: 564, y: 282 },
    grow: { x: 200, y: 200, width: 496, height: 296 },
  })
})

it('a neighbour frame reaching into the frame is not what the next note goes below', () => {
  // The neighbour overlaps the frame's right side and ends lower; the frame
  // grows away from it, and the note stays level with the frame's own notes.
  const full = groupNode({ id: 'f', x: 200, y: 200, width: 264, height: 296, label: 'Next' })
  const a = textNode({ id: 'a', x: 232, y: 232, width: 200, height: 100, text: 'a' })
  const b = textNode({ id: 'b', x: 232, y: 364, width: 200, height: 100, text: 'b' })
  const over = groupNode({ id: 'o', x: 440, y: 100, width: 320, height: 600, label: 'Now' })
  const spot = nextSpotInFrame(full, [over, full, a, b], size)
  expect(spot.center.y).toBeLessThan(496)
  expect(spot.grow).toEqual({ x: -32, y: 200, width: 496, height: 296 })
})

it('a named frame reserves its name strip; an unnamed one draws none', () => {
  const unnamed = groupNode({ id: 'u', x: 0, y: 0, width: 100, height: 50 })
  const obstacles = creationObstacles({ nodes: [frame, unnamed], edges: [] })
  // Both boxes, and one strip: the named frame's.
  expect(obstacles).toHaveLength(3)
  expect(obstacles).toContainEqual({ x: 200, y: 156, width: 400, height: 44 })
})

it('a note asked for beside a node in nested frames goes to the innermost frame', () => {
  const outer = groupNode({ id: 'o', x: 0, y: 0, width: 1000, height: 1000 })
  const inner = groupNode({ id: 'i', x: 100, y: 100, width: 500, height: 400 })
  const note = textNode({ id: 'n', x: 150, y: 150, width: 200, height: 100, text: 'x' })
  const loose = textNode({ id: 'l', x: 2000, y: 0, width: 200, height: 100, text: 'y' })
  const nodes = [outer, inner, note, loose]
  expect(frameForNewNote(note, nodes)?.id).toBe('i')
  expect(frameForNewNote(inner, nodes)?.id).toBe('i')
  expect(frameForNewNote(loose, nodes)).toBeUndefined()
  expect(frameForNewNote(undefined, nodes)).toBeUndefined()
})

it('a frame boxed in on every side grows down from its own notes, not a neighbour', () => {
  const full = groupNode({ id: 'f', x: 200, y: 200, width: 264, height: 296, label: 'Next' })
  const a = textNode({ id: 'a', x: 232, y: 232, width: 200, height: 100, text: 'a' })
  const b = textNode({ id: 'b', x: 232, y: 364, width: 200, height: 100, text: 'b' })
  const over = groupNode({ id: 'o', x: 440, y: 100, width: 320, height: 600, label: 'Now' })
  const beside = groupNode({ id: 's', x: -300, y: 200, width: 280, height: 200, label: 'Then' })
  expect(nextSpotInFrame(full, [over, beside, full, a, b], size)).toEqual({
    center: { x: 332, y: 546 },
    grow: { x: 200, y: 200, width: 264, height: 428 },
  })
})
