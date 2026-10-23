import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { expect, it } from 'vitest'
import { contextMenuHeading } from './context-menu-heading.js'

const none = { node: undefined, edge: undefined, line: undefined, comment: undefined }

it('names a note menu for the note, aloud and on the sheet', () => {
  const node = textNode({ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'Orders' })
  expect(contextMenuHeading({ ...none, node, editing: false, nodes: [node] })).toEqual({
    label: 'Actions for Note: Orders',
    title: 'Note: Orders',
  })
})

it('keeps the surface name for a press on empty space', () => {
  expect(contextMenuHeading({ ...none, editing: false, nodes: [] })).toEqual({
    label: 'Canvas actions',
    title: 'Canvas',
  })
})

it('names an edge menu for the route it joins', () => {
  const a = textNode({ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'A' })
  const b = textNode({ id: 'b', x: 50, y: 0, width: 10, height: 10, text: 'B' })
  const edge = { id: 'e', from: { node: 'a' }, to: { node: 'b' } }
  expect(contextMenuHeading({ ...none, edge, editing: false, nodes: [a, b] }).title).toBe(
    'Edge from A to B',
  )
})
