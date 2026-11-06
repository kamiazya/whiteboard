import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { expect, it } from 'vitest'
import { freehandLine } from '../../lib/spatial/freehand.js'
import { contextMenuHeading } from './context-menu-heading.js'

const none = { node: undefined, edge: undefined, line: undefined, comment: undefined }

it('names a note menu for the note, aloud and on the sheet', () => {
  const node = textNode({ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'Orders' })
  expect(contextMenuHeading({ ...none, node }, [node], false)).toEqual({
    label: 'Actions for Note: Orders',
    title: 'Note: Orders',
  })
})

it('keeps the surface name for a press on empty space', () => {
  expect(contextMenuHeading(none, [], false)).toEqual({
    label: 'Canvas actions',
    title: 'Canvas',
  })
})

it('names an edge menu for the route it joins', () => {
  const a = textNode({ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'A' })
  const b = textNode({ id: 'b', x: 50, y: 0, width: 10, height: 10, text: 'B' })
  const edge = { id: 'e', from: { node: 'a' }, to: { node: 'b' } }
  expect(contextMenuHeading({ ...none, edge }, [a, b], false).title).toBe('Connection from A to B')
})

it('names a pen stroke’s menu as the drawing it is, and a ruled line as a line', () => {
  const stroke = freehandLine(
    's',
    [
      { x: 0, y: 0 },
      { x: 40, y: 30 },
      { x: 80, y: 0 },
    ],
    1,
  )
  if (stroke === undefined) throw new Error('no stroke')
  expect(contextMenuHeading({ ...none, line: stroke }, [], false)).toEqual({
    label: 'Actions for Drawing',
    title: 'Drawing',
  })
  const ruled = {
    id: 'r',
    from: { kind: 'point' as const, point: { x: 0, y: 0 } },
    to: { kind: 'point' as const, point: { x: 80, y: 0 } },
  }
  expect(contextMenuHeading({ ...none, line: ruled }, [], false).label).toBe('Actions for Line')
})
