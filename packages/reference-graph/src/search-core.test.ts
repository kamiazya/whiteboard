import { writeDocumentKind, writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { installSearchCore, type SearchCore } from '@kamiazya/whiteboard-search'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it } from 'vitest'
import { extractContentFacts } from './extract.js'
import { backlinksIn } from './reference-aggregate.js'

// Extraction and the excerpts answer through the realm's search core. A core
// that declines an input past its caps is answered with the degraded form each
// one already had, never a thrown refusal; any other failure stays loud.

const A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const B = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

const refusal = () => {
  const err = new Error('past the cap')
  err.name = 'CoreInputRefused'
  return err
}

let restore: SearchCore | undefined
const withCore = (over: Partial<SearchCore>) => {
  const real = installSearchCore(undefined)
  if (real === undefined) throw new Error('the test realm installs a search core')
  restore = real
  installSearchCore({ ...real, ...over })
}
afterEach(() => {
  if (restore !== undefined) installSearchCore(restore)
  restore = undefined
})

const entries = [
  { documentId: A, path: 'plan', kind: 'markdown' as const },
  { documentId: B, path: 'notes', kind: 'markdown' as const },
]
const text = 'see [[plan]] here'
const facts = new Map([
  [
    B,
    {
      refs: [{ target: 'plan', via: 'wikilink' as const, byId: false, text, index: 4, length: 8 }],
      texts: [],
    },
  ],
])

describe('backlinks when the search core declines an input', () => {
  it('answers the matched span for an excerpt the core refuses, and still lists the source', () => {
    withCore({
      snippetAround: () => {
        throw refusal()
      },
    })
    const { backlinks } = backlinksIn(entries as never, facts, A)
    expect(backlinks.map((entry) => entry.contexts)).toEqual([['[[plan]]']])
  })

  it('labels nothing when the core refuses the listing, and releases nothing it never got', () => {
    withCore({
      linkLabels: () => {
        throw refusal()
      },
    })
    const { backlinks } = backlinksIn(entries as never, facts, A)
    expect(backlinks.map((entry) => entry.contexts)).toEqual([['see plan here']])
  })

  it('releases the labels it held, also when an excerpt throws something else', () => {
    let released = 0
    withCore({
      linkLabels: () => ({
        release: () => {
          released++
        },
      }),
      snippetAround: () => {
        throw new Error('a defect')
      },
    })
    expect(() => backlinksIn(entries as never, facts, A)).toThrowError('a defect')
    expect(released).toBe(1)
  })

  it('releases the labels after answering', () => {
    let released = 0
    withCore({
      linkLabels: (listing) => {
        const real = (restore as SearchCore).linkLabels(listing)
        return {
          release: () => {
            released++
            real.release()
          },
        }
      },
      snippetAround: () => 'excerpt',
    })
    expect(backlinksIn(entries as never, facts, A).backlinks).toHaveLength(1)
    expect(released).toBe(1)
  })
})

describe('extraction when the search core declines an input', () => {
  const doc = () => {
    const loro = new LoroDoc()
    writeDocumentKind(loro, 'markdown')
    writeMarkdownBody(loro, 'a [[plan]] b')
    return loro
  }

  it('keeps the references and searches the document as nothing', () => {
    withCore({
      searchableTexts: () => {
        throw refusal()
      },
    })
    const extracted = extractContentFacts({ kind: 'markdown' }, doc())
    expect(extracted.texts).toEqual([])
    expect(extracted.refs.map((ref) => ref.target)).toEqual(['plan'])
  })

  it('does not hide a failure that is not a refusal', () => {
    withCore({
      searchableTexts: () => {
        throw new Error('a defect')
      },
    })
    expect(() => extractContentFacts({ kind: 'markdown' }, doc())).toThrowError('a defect')
  })
})
