import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { searchableTexts } from './searchable-texts.js'

describe('searchableTexts', () => {
  it('gives a markdown document its body', () => {
    expect(searchableTexts({ kind: 'markdown', body: '# Roadmap\n\nShip search.' })).toEqual([
      '# Roadmap\n\nShip search.',
    ])
  })

  // A canvas means through its RELATIONS: an edge label is content, and a
  // group label names a region the way a heading names a section.
  it('gives a canvas its node texts, group labels and edge labels', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        { id: 'n1', type: 'text', text: 'Auth flow', x: 0, y: 0, width: 100, height: 40 },
        { id: 'g1', type: 'group', label: 'Backlog', x: 0, y: 0, width: 200, height: 200 },
      ],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'g1', label: 'blocks' }],
    }
    expect(searchableTexts({ kind: 'spatial', canvas })).toEqual(['Auth flow', 'Backlog', 'blocks'])
  })

  it('leaves out what carries no label', () => {
    const canvas: SpatialCanvas = {
      nodes: [{ id: 'g1', type: 'group', x: 0, y: 0, width: 10, height: 10 }],
      edges: [{ id: 'e1', fromNode: 'g1', toNode: 'g1' }],
    }
    expect(searchableTexts({ kind: 'spatial', canvas })).toEqual([])
  })
})
