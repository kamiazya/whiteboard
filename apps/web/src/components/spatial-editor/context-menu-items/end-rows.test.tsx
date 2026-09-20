// @vitest-environment node
// The shared end rows, pinned as plain function calls: the rows are data, so
// which option is ticked and what a pick writes need no DOM.
//
// The case that matters most here is the DEFAULT arrowhead, because it is
// read from the element's kind rather than stored: a relation points by
// default (JSON Canvas `toEnd: arrow`) and a stroke does not.
import type { CanvasEdge, CanvasLine } from '@kamiazya/whiteboard-model'
import { describe, expect, it, vi } from 'vitest'
import { arrowRow, endMeetsNode, sideRow } from './end-rows.js'

const relation: CanvasEdge = { id: 'e1', from: { node: 'a' }, to: { node: 'b' } }

const strokeOnNode: CanvasLine = {
  id: 'l1',
  from: { kind: 'node', node: 'a' },
  to: { kind: 'point', point: { x: 500, y: 400 } },
}

const strokeInAir: CanvasLine = {
  id: 'l2',
  from: { kind: 'point', point: { x: 200, y: 300 } },
  to: { kind: 'point', point: { x: 500, y: 300 } },
}

const tickedIn = (element: CanvasEdge | CanvasLine): string | undefined =>
  arrowRow(element, vi.fn()).options.find((option) => option.selected)?.ariaLabel

describe('arrowRow', () => {
  it('ticks Forward for a relation that stores no arrowhead', () => {
    expect(tickedIn(relation)).toBe('Forward')
  })

  it('ticks None for a stroke that stores no arrowhead, whether or not an end is on a node', () => {
    // The whole point of reading the default per kind. A line end ON a node
    // carries a `node` property exactly as an edge end does, so telling the
    // two apart by that property alone reads a stroke as a relation — and
    // this row then shows an arrowhead the stroke has not got.
    expect(tickedIn(strokeInAir)).toBe('None')
    expect(tickedIn(strokeOnNode)).toBe('None')
  })

  it('ticks what an element actually stores over either default', () => {
    expect(
      tickedIn({ ...strokeOnNode, to: { kind: 'point', point: { x: 1, y: 2 }, end: 'arrow' } }),
    ).toBe('Forward')
    expect(tickedIn({ ...relation, to: { node: 'b', end: 'none' } })).toBe('None')
  })

  it('hands the picked pair to the caller, which owns the command', () => {
    const apply = vi.fn()
    const row = arrowRow(strokeInAir, apply)
    row.options.find((option) => option.ariaLabel === 'Both')?.onSelect()
    expect(apply).toHaveBeenCalledWith({ fromEnd: 'arrow', toEnd: 'arrow' })
  })
})

describe('sideRow', () => {
  it('ticks the side an end pins, and Auto when it pins none', () => {
    const pinned = sideRow(
      { ...strokeOnNode, from: { kind: 'node', node: 'a', side: 'top' } },
      'from',
      vi.fn(),
    )
    expect(pinned.options.find((option) => option.selected)?.ariaLabel).toBe('Top')
    expect(sideRow(strokeOnNode, 'from', vi.fn()).options.find((o) => o.selected)?.ariaLabel).toBe(
      'Auto',
    )
  })

  it('writes undefined for Auto, so unpinning is the router deciding again', () => {
    const apply = vi.fn()
    sideRow(strokeOnNode, 'from', apply)
      .options.find((o) => o.ariaLabel === 'Auto')
      ?.onSelect()
    expect(apply).toHaveBeenCalledWith(undefined)
  })
})

describe('endMeetsNode', () => {
  it('is true only where the end is on a box, since a free end has no side to pin', () => {
    expect(endMeetsNode(strokeOnNode, 'from')).toBe(true)
    expect(endMeetsNode(strokeOnNode, 'to')).toBe(false)
    expect(endMeetsNode(relation, 'from')).toBe(true)
  })
})
