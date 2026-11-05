import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { expect, it } from 'vitest'
import { frameTitleAt, nameStrips, nextSpotInFrame, pointInsideFrame } from './frame-interior.js'

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
    grownHeight: 428,
  })
})

it('a named frame reserves its name strip; an unnamed one draws none', () => {
  const unnamed = groupNode({ id: 'u', x: 0, y: 0, width: 100, height: 50 })
  expect(nameStrips([frame, unnamed])).toEqual([{ x: 200, y: 156, width: 400, height: 44 }])
})
