import { describe, expect, it } from 'vitest'
import { readTagVocabulary } from './use-tag-vocabulary.js'

describe('readTagVocabulary', () => {
  it('joins what the keeper uses with what it declares, tags as strings', async () => {
    const source = {
      listTagsInUse: () =>
        Promise.resolve([
          {
            tag: 'health:ok',
            key: 'health',
            value: 'ok',
            documents: 0,
            boards: 0,
            nodes: 2,
            edges: 0,
          },
          { tag: 'ops', documents: 1, boards: 0, nodes: 0, edges: 0 },
        ]),
      readTagLibrary: () => Promise.resolve({ health: { values: { ok: { color: '4' } } } }),
    }
    await expect(readTagVocabulary(source)).resolves.toEqual({
      inUse: ['health:ok', 'ops'],
      library: { health: { values: { ok: { color: '4' } } } },
    })
  })

  it('answers an empty vocabulary for a source that cannot say', async () => {
    await expect(readTagVocabulary({})).resolves.toEqual({ inUse: [], library: {} })
  })
})
