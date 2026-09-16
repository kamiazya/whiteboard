import { describe, expect, it } from 'vitest'
import { countTagsInUse } from './tags-in-use.js'

describe('countTagsInUse', () => {
  it('counts each tag by what carries it, names a scoped tag’s key and value, sorted by tag', () => {
    expect(
      countTagsInUse([
        { what: 'document', tags: ['release', 'q3'] },
        { what: 'board', tags: ['team:core'] },
        { what: 'node', tags: ['health:ok', 'health:ok'] },
        { what: 'node', tags: ['health:failing'] },
        { what: 'edge', tags: ['link:slow'] },
        { what: 'document', tags: ['q3'] },
      ]),
    ).toEqual([
      {
        tag: 'health:failing',
        key: 'health',
        value: 'failing',
        documents: 0,
        boards: 0,
        nodes: 1,
        edges: 0,
      },
      { tag: 'health:ok', key: 'health', value: 'ok', documents: 0, boards: 0, nodes: 1, edges: 0 },
      { tag: 'link:slow', key: 'link', value: 'slow', documents: 0, boards: 0, nodes: 0, edges: 1 },
      { tag: 'q3', documents: 2, boards: 0, nodes: 0, edges: 0 },
      { tag: 'release', documents: 1, boards: 0, nodes: 0, edges: 0 },
      { tag: 'team:core', key: 'team', value: 'core', documents: 0, boards: 1, nodes: 0, edges: 0 },
    ])
  })

  it('answers nothing for no bearers', () => {
    expect(countTagsInUse([])).toEqual([])
  })
})
