import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { collectCanvasTags, retag } from './tags.js'

describe('collectCanvasTags', () => {
  it('answers every tag the board, its nodes and its edges carry, once each, sorted', () => {
    const canvas: SpatialCanvas = {
      tags: ['team:core', 'draft'],
      nodes: [
        textNode({ id: 'a', text: 'a', x: 0, y: 0, width: 10, height: 10, tags: ['health:ok'] }),
        textNode({
          id: 'b',
          text: 'b',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          tags: ['health:failing', 'draft'],
        }),
        textNode({ id: 'c', text: 'c', x: 0, y: 0, width: 10, height: 10 }),
      ],
      edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' }, tags: ['link:ok'] }],
    }
    expect(collectCanvasTags(canvas)).toEqual([
      'draft',
      'health:failing',
      'health:ok',
      'link:ok',
      'team:core',
    ])
  })

  it('an untagged board answers nothing', () => {
    expect(collectCanvasTags({ nodes: [], edges: [] })).toEqual([])
  })
})

// The panel shows ONE object's chips and writes to the whole selection, so
// what travels to each selected object is the CHANGE the person made — the
// tag added or the chip removed — applied to that object's own list, never
// the shown list copied over it. Set semantics, like wb_facet_set's add/remove.
describe('retag', () => {
  it('adds what the edit added and removes what it removed, keeping the rest of the target’s own tags', () => {
    expect(retag(['mine', 'old'], ['old', 'shown'], ['shown', 'new'])).toEqual(['mine', 'new'])
  })

  it('a tag the edit added that the target already carries is not doubled', () => {
    expect(retag(['new'], [], ['new'])).toEqual(['new'])
  })

  it('an untagged target gets only the additions', () => {
    expect(retag(undefined, ['a'], ['a', 'b'])).toEqual(['b'])
  })

  it('removing a tag the target never had is a no-op', () => {
    expect(retag(['x'], ['gone'], [])).toEqual(['x'])
  })
})
