import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { expect, it } from 'vitest'
import { frameTitleAt, pointInsideFrame } from './frame-interior.js'

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
