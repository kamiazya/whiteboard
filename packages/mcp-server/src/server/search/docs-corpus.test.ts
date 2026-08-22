import { describe, expect, it } from 'vitest'
import { corpusDigest, DOCS_JUDGED_QUERIES, loadDocsCorpus, queryDigest } from './docs-corpus.js'

const repoRoot = new URL('../../../../../', import.meta.url).pathname

describe('loadDocsCorpus', () => {
  it('reads the real docs tree, sorted, with the h1 as the name', () => {
    const docs = loadDocsCorpus(repoRoot)
    expect(docs.length).toBeGreaterThan(20)
    expect([...docs].sort((a, b) => a.path.localeCompare(b.path))).toEqual(docs)
    const readme = docs.find((d) => d.path === 'README')
    expect(readme?.name).toBe('Whiteboard documentation')
  })

  it('judges only paths that exist, so a renamed document fails loudly', () => {
    const paths = new Set(loadDocsCorpus(repoRoot).map((d) => d.path))
    for (const judged of DOCS_JUDGED_QUERIES) {
      for (const path of Object.keys(judged.relevant)) {
        expect(paths, `${judged.query} judges a missing document`).toContain(path)
      }
    }
  })
})

describe('digests', () => {
  it('changes when any document body changes', () => {
    const docs = loadDocsCorpus(repoRoot)
    const edited = docs.map((d, i) => (i === 0 ? { ...d, body: `${d.body} .` } : d))
    expect(corpusDigest(edited)).not.toBe(corpusDigest(docs))
  })

  it('changes when a document is added or removed', () => {
    const docs = loadDocsCorpus(repoRoot)
    expect(corpusDigest(docs.slice(1))).not.toBe(corpusDigest(docs))
  })

  it('is stable across repeated reads of an unchanged tree', () => {
    expect(corpusDigest(loadDocsCorpus(repoRoot))).toBe(corpusDigest(loadDocsCorpus(repoRoot)))
  })

  it('separates the query set from the corpus, so a report says which moved', () => {
    const a = queryDigest(DOCS_JUDGED_QUERIES)
    const b = queryDigest([...DOCS_JUDGED_QUERIES].slice(1))
    expect(a).not.toBe(b)
    expect(a).toBe(queryDigest(DOCS_JUDGED_QUERIES))
  })

  it('changes when a JUDGEMENT changes, not only when a query is added', () => {
    const [first, ...rest] = DOCS_JUDGED_QUERIES
    const regraded = [{ ...first, relevant: { ...first.relevant, README: 1 } }, ...rest]
    expect(queryDigest(regraded)).not.toBe(queryDigest(DOCS_JUDGED_QUERIES))
  })
})
