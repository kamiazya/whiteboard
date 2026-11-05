import { describe, expect, it } from 'vitest'
import { backlinksIn } from './reference-aggregate.js'

const TARGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SOURCE = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const OTHER = '01CX5ZZKBKACTAV9WEVGEMMVRZ'

const entries = [
  {
    documentId: TARGET,
    path: 'folder/deep-learning/transformer',
    name: 'Transformer',
    kind: 'markdown' as const,
  },
  { documentId: SOURCE, path: 'folder/gaiyo', name: '概要', kind: 'markdown' as const },
  { documentId: OTHER, path: 'folder/deep-learning/bert', name: 'BERT', kind: 'markdown' as const },
]

describe('backlink and mention excerpts', () => {
  it('show each [[link]] as the display name of what it points at', () => {
    const link = '[[folder/deep-learning/transformer]]'
    const text = `基盤は ${link} のエンコーダ、比較は [[folder/deep-learning/bert]]。Transformer 再訪`
    const refs = [
      {
        target: 'folder/deep-learning/transformer',
        via: 'wikilink' as const,
        byId: false,
        text,
        index: text.indexOf(link),
        length: link.length,
      },
    ]
    const out = backlinksIn(entries as never, new Map([[SOURCE, { refs, texts: [text] }]]), TARGET)
    expect(out.backlinks[0]?.contexts).toEqual([
      '基盤は Transformer のエンコーダ、比較は BERT。Transformer 再訪',
    ])
    // The unlinked mention's excerpt reads the links the same way.
    expect(out.unlinkedMentions[0]?.contexts[0]).toContain('比較は BERT')
    expect(out.unlinkedMentions[0]?.contexts[0]).not.toContain('[[')
  })
})
