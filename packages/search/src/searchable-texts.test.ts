import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { fullTextSearch } from './full-text.js'
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

  // The url is exactly what canvas-render's `labelOf` draws for a link node,
  // so it is content the reader can see and search for.
  it('gives a canvas a link node’s url', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        {
          id: 'l1',
          type: 'link',
          url: 'https://example.com/runbooks/oncall',
          x: 0,
          y: 0,
          width: 100,
          height: 40,
        },
      ],
      edges: [],
    }
    expect(searchableTexts({ kind: 'spatial', canvas })).toEqual([
      'https://example.com/runbooks/oncall',
    ])
  })

  // Not an oversight. A file node's readable label is `resolved?.label` —
  // behind the reference resolver this package deliberately does not take —
  // and the raw `node.file` is an opaque id, so indexing it would add noise
  // rather than recall.
  it('leaves a file node out, because its readable label is not in the content', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        {
          id: 'f1',
          type: 'file',
          file: '01JBQ7Z2K3M4N5P6Q7R8S9T0V1',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
      ],
      edges: [],
    }
    expect(searchableTexts({ kind: 'spatial', canvas })).toEqual([])
  })

  it('leaves out what carries no label', () => {
    const canvas: SpatialCanvas = {
      nodes: [{ id: 'g1', type: 'group', x: 0, y: 0, width: 10, height: 10 }],
      edges: [{ id: 'e1', fromNode: 'g1', toNode: 'g1' }],
    }
    expect(searchableTexts({ kind: 'spatial', canvas })).toEqual([])
  })
})

/**
 * What the projection is FOR. `searchableTexts` returning a string proves
 * only that the string is in an array; whether a user can find the document
 * by it depends on the tokenizer, which splits on everything that is not a
 * letter or a digit. Joining the two here is still the nearest layer — both
 * halves live in this package — and it is the only place the recall claim is
 * actually asserted.
 */
describe('a canvas through searchableTexts and into fullTextSearch', () => {
  it('finds a document by the host of a link node it holds', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        {
          id: 'l1',
          type: 'link',
          url: 'https://runbooks.example.com/oncall',
          x: 0,
          y: 0,
          width: 100,
          height: 40,
        },
      ],
      edges: [],
    }
    const results = fullTextSearch(
      [
        { documentId: 'a', path: 'a', texts: searchableTexts({ kind: 'spatial', canvas }) },
        { documentId: 'b', path: 'b', texts: ['nothing to do with any of this'] },
      ],
      'runbooks',
    )
    expect(results.map((result) => result.documentId)).toEqual(['a'])
  })
})
