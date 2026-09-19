// ADR-0040 decision 5's declared layer, applied to a drawing: a box or an
// edge that carries a tag whose value the workspace's library colours, and
// has no colour of its own, is drawn in the declared colour. Done on the
// CANVAS rather than in the appearance resolver so the facet score, the
// appearance and the legend all see the same intent — a legend judged by a
// score that reads `node.color` would otherwise never list a key the
// library colours.
import type { CanvasColor, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it } from 'vitest'
import { withDeclaredColours } from './declared-colours.js'

const library: TagLibrary = {
  health: { exclusive: true, values: { ok: { color: '4' }, failing: { color: '1' } } },
  tier: { values: { web: { color: '5' }, db: {} } },
  owner: {},
}
const box = (id: string, tags?: string[], color?: CanvasColor) => {
  const fields: Parameters<typeof textNode>[0] = {
    id,
    text: id,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
  }
  if (tags !== undefined) fields.tags = tags
  if (color !== undefined) fields.color = color
  return textNode(fields)
}

describe('withDeclaredColours', () => {
  it('colours a box and an edge by the value the library declares', () => {
    const canvas: SpatialCanvas = {
      nodes: [box('api', ['health:ok']), box('db', ['health:failing'])],
      edges: [{ id: 'e', from: { node: 'api' }, to: { node: 'db' }, tags: ['health:failing'] }],
    }
    const out = withDeclaredColours(canvas, library)
    expect(out.nodes.map((n) => n.color)).toEqual(['4', '1'])
    expect(out.edges[0]?.color).toBe('1')
  })

  it('never overrides a colour the thing carries itself', () => {
    const canvas: SpatialCanvas = { nodes: [box('api', ['health:ok'], '2')], edges: [] }
    expect(withDeclaredColours(canvas, library).nodes[0]?.color).toBe('2')
  })

  it('leaves a thing alone when two of its tags declare colours — intent is contested', () => {
    const canvas: SpatialCanvas = { nodes: [box('api', ['health:ok', 'tier:web'])], edges: [] }
    expect(withDeclaredColours(canvas, library).nodes[0]?.color).toBeUndefined()
  })

  it('ignores a plain tag, an undeclared key, an undeclared value, and a value declared without a colour', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        box('a', ['draft']),
        box('b', ['region:eu']),
        box('c', ['health:degraded']),
        box('d', ['tier:db']),
        box('e', ['owner:core']),
      ],
      edges: [],
    }
    expect(withDeclaredColours(canvas, library).nodes.map((n) => n.color)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  // The four below are one example each for a mutant the lane reported
  // surviving on this file: a tag the library says nothing about beside a
  // coloured one, two keys agreeing on a colour, an absent library over a
  // scoped tag, and an edge coloured where no node is.
  it('keeps the colour when an undeclared tag sits beside the declared one, in either order', () => {
    const canvas: SpatialCanvas = {
      nodes: [box('a', ['health:ok', 'owner:core']), box('b', ['region:eu', 'health:failing'])],
      edges: [],
    }
    expect(withDeclaredColours(canvas, library).nodes.map((n) => n.color)).toEqual(['4', '1'])
  })

  it('colours a thing whose two keys agree on the colour — that is one intent, not two', () => {
    const agreeing: TagLibrary = { ...library, env: { values: { prod: { color: '4' } } } }
    const canvas: SpatialCanvas = { nodes: [box('a', ['health:ok', 'env:prod'])], edges: [] }
    expect(withDeclaredColours(canvas, agreeing).nodes[0]?.color).toBe('4')
  })

  it('answers the same canvas object for no library at all, even over a scoped tag', () => {
    const canvas: SpatialCanvas = { nodes: [box('a', ['health:ok'])], edges: [] }
    expect(withDeclaredColours(canvas, undefined)).toBe(canvas)
  })

  it('colours an edge when no node changes, and answers a new canvas for it', () => {
    const canvas: SpatialCanvas = {
      nodes: [box('a'), box('b')],
      edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' }, tags: ['health:ok'] }],
    }
    const out = withDeclaredColours(canvas, library)
    expect(out).not.toBe(canvas)
    expect(out.edges[0]?.color).toBe('4')
  })

  it('answers the same canvas object when nothing is coloured, so a memo keyed on identity holds', () => {
    const canvas: SpatialCanvas = {
      nodes: [box('a', ['draft']), box('b')],
      edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' }, tags: ['owner:core'] }],
    }
    expect(withDeclaredColours(canvas, library)).toBe(canvas)
    expect(withDeclaredColours(canvas, {})).toBe(canvas)
  })
})
