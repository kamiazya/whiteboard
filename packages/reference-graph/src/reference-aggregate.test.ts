import { describe, expect, it } from 'vitest'
import { backlinksIn, unlinkedNameSpans } from './reference-aggregate.js'

const A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const B = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

describe('unlinked mentions', () => {
  it('counts a name that starts exactly where a [[link]] ends as an unlinked mention', () => {
    expect(unlinkedNameSpans('[[Plan]]Plan', 'Plan')).toEqual([{ index: 8, length: 4 }])
  })

  it('skips a name inside the link target or alias', () => {
    expect(unlinkedNameSpans('[[Plan|Plan]] and Plan', 'Plan')).toEqual([{ index: 18, length: 4 }])
  })

  it('carries at most three contexts per mentioning document, and the kind', () => {
    const entries = [
      { documentId: A, path: 'plan', name: 'Plan', kind: 'markdown' as const },
      { documentId: B, path: 'notes', name: 'Notes', kind: 'markdown' as const },
    ]
    const texts = ['Plan one', 'Plan two', 'Plan three', 'Plan four', 'Plan five']
    const out = backlinksIn(entries as never, new Map([[B, { refs: [], texts }]]), A)
    expect(out.unlinkedMentions).toHaveLength(1)
    expect(out.unlinkedMentions[0]?.contexts).toHaveLength(3)
    expect(out.unlinkedMentions[0]?.kind).toBe('markdown')
  })

  it('lists no document without a mention, and never lists a document as mentioning itself', () => {
    const entries = [
      { documentId: A, path: 'plan', name: 'Plan', kind: 'markdown' as const },
      { documentId: B, path: 'notes', name: 'Notes', kind: 'markdown' as const },
    ]
    const out = backlinksIn(
      entries as never,
      new Map([
        [A, { refs: [], texts: ['Plan itself'] }],
        [B, { refs: [], texts: ['nothing here'] }],
      ]),
      A,
    )
    expect(out.unlinkedMentions).toEqual([])
  })
})
