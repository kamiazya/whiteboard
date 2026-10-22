import { scanReferences } from '@kamiazya/whiteboard-codec'
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { fc, fcTest, withDefaults } from '@kamiazya/whiteboard-model/test-utils'
import { snippetAround } from '@kamiazya/whiteboard-search'
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

describe('backlinks', () => {
  it('reads an id-shaped target as the id, even where a document has that as its path', () => {
    const C = '01CX5ZZKBKACTAV9WEVGEMMVRZ'
    // A's path spells C's id; `[[C]]` names C and never A.
    const entries = [
      { documentId: A, path: C, kind: 'markdown' as const },
      { documentId: B, path: 'notes', kind: 'markdown' as const },
      { documentId: C, path: 'other', kind: 'markdown' as const },
    ]
    const text = `[[${C}]]`
    const refs = [{ target: C, via: 'wikilink' as const, byId: true, text, index: 0, length: 30 }]
    const content = new Map([[B, { refs, texts: [] }]])
    expect(backlinksIn(entries as never, content, A).backlinks).toEqual([])
    expect(backlinksIn(entries as never, content, C).backlinks.map((b) => b.documentId)).toEqual([
      B,
    ])
  })

  it('carries the first three references of a source as excerpts, in document order', () => {
    const entries = [
      { documentId: A, path: 'plan', kind: 'markdown' as const },
      { documentId: B, path: 'notes', kind: 'markdown' as const },
    ]
    const text = '[[plan]] one [[plan]] two [[01ARZ3NDEKTSV4RRFFQ69G5FAV]] three [[plan]] four'
    const refs = scanReferences(text).map((match) => ({
      target: match.target,
      via: 'wikilink' as const,
      byId: match.target === A,
      text,
      index: match.index,
      length: match.full.length,
    }))
    const out = backlinksIn(entries as never, new Map([[B, { refs, texts: [] }]]), A)
    expect(out.backlinks).toHaveLength(1)
    expect(out.backlinks[0]?.contexts).toEqual(
      refs.slice(0, 3).map((ref) => snippetAround(text, ref.index, ref.length)),
    )
  })
})

/**
 * The exclusion rule written the slow, obvious way: mark every character a
 * reference covers, then keep the occurrences that land on an unmarked one.
 * It reads the grammar through `scanReferences`, the grammar's one
 * definition; what it shares nothing with is the subject's walk over spans.
 */
function spansOracle(text: string, name: string): { index: number; length: number }[] {
  const covered = new Array<boolean>(text.length).fill(false)
  for (const match of scanReferences(text)) {
    for (let i = match.index; i < match.index + match.full.length; i++) covered[i] = true
  }
  const spans: { index: number; length: number }[] = []
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + name.length)) {
    if (!covered[at]) spans.push({ index: at, length: name.length })
  }
  return spans
}

// Pieces of the grammar and of the name, so a mention lands inside, beside
// and across a reference often rather than by luck (measured: ~420 of 2000
// samples exclude one, ~1030 keep one).
const PIECE = fc.constantFrom(
  '[[',
  ']]',
  '[[Plan',
  'Plan]]',
  '[[x]]',
  '![[x]]',
  '|',
  'Plan',
  'Pl',
  'an',
  ' ',
  '#',
  'x',
)
const textArbitrary = fc.array(PIECE, { maxLength: 14 }).map((pieces) => pieces.join(''))

describe('unlinkedNameSpans, against the obvious rule', () => {
  fcTest.prop([textArbitrary, fc.constantFrom('Plan', 'an', 'Plan Plan')], withDefaults())(
    'finds exactly the occurrences no reference covers',
    (text, name) => {
      expect(unlinkedNameSpans(text, name)).toEqual(spansOracle(text, name))
    },
  )

  it('the generator reaches mentions both inside and outside references', () => {
    const samples = fc.sample(textArbitrary, { numRuns: 2000 })
    const excluded = samples.filter(
      (text) => spansOracle(text, 'Plan').length < text.split('Plan').length - 1,
    )
    const kept = samples.filter((text) => spansOracle(text, 'Plan').length > 0)
    expect(excluded.length).toBeGreaterThan(300)
    expect(kept.length).toBeGreaterThan(800)
  })

  it('stays linear in a body with as many references as mentions', () => {
    // A body at the document ceiling. Walking every reference per mention
    // measured ~1s at a half of this and quadruples per doubling; a linear
    // pass is milliseconds, so the bound is far from both.
    const text = '[[q]] N '.repeat(Math.floor(MARKDOWN_MAX_CHARS / 8))
    const start = performance.now()
    const spans = unlinkedNameSpans(text, 'N')
    const elapsed = performance.now() - start
    expect(spans).toHaveLength(Math.floor(MARKDOWN_MAX_CHARS / 8))
    expect(elapsed).toBeLessThan(1000)
  })
})
