import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  readCoreFacets,
  readTrustFacets,
  writeCoreFacets,
  writeDocumentKind,
  writeTrustFacets,
} from './document-envelope.js'

const GENERATED = { by: 'reference_agent/gemini-2.5-pro', at: '2026-06-20T22:53:05Z' } as const
const VERIFIED = [{ by: 'human:ahormati', at: '2026-06-25T09:00:00Z' }] as const

function markdownDoc(): LoroDoc {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'markdown')
  return doc
}

describe('the trust family has a bucket of its own (ADR-0016 decision 4)', () => {
  it('round-trips generated and verified', () => {
    const doc = markdownDoc()
    writeTrustFacets(doc, { generated: GENERATED, verified: [...VERIFIED] })

    expect(readTrustFacets(doc)).toEqual({ generated: GENERATED, verified: VERIFIED })
  })

  /**
   * The whole reason for the separate bucket. `writeCoreFacets` replaces the
   * core bucket outright and deletes any field the caller omitted, so a stamp
   * stored there would be erased by a client that only meant to edit its tags.
   */
  it('survives a whole-bucket core-facet rewrite', () => {
    const doc = markdownDoc()
    writeTrustFacets(doc, { generated: GENERATED })
    writeCoreFacets(doc, { type: 'note', tags: ['a'] })
    writeCoreFacets(doc, { type: 'note' })

    expect(readTrustFacets(doc)).toEqual({ generated: GENERATED })
    expect(readCoreFacets(doc)?.tags).toBeUndefined()
  })

  it('is replace-on-rewrite, matching writeCoreFacets and writeFacets', () => {
    const doc = markdownDoc()
    writeTrustFacets(doc, { generated: GENERATED, verified: [...VERIFIED] })
    writeTrustFacets(doc, { generated: GENERATED })

    expect(readTrustFacets(doc)).toEqual({ generated: GENERATED })
  })

  it('answers undefined for a document that never carried one', () => {
    expect(readTrustFacets(markdownDoc())).toBeUndefined()
  })

  it('answers undefined for a spatial document, whatever the bucket holds', () => {
    const doc = new LoroDoc()
    writeTrustFacets(doc, { generated: GENERATED })
    writeDocumentKind(doc, 'spatial')

    expect(readTrustFacets(doc)).toBeUndefined()
  })

  it('drops one corrupt field rather than failing the whole read', () => {
    const doc = markdownDoc()
    writeTrustFacets(doc, { generated: GENERATED, verified: [...VERIFIED] })
    doc.getMap('trust').set('verified', 'not a list')
    doc.commit()

    expect(readTrustFacets(doc)).toEqual({ generated: GENERATED })
  })

  // A LoroMap key is a CRDT string, so `__proto__` stores and enumerates like
  // any other, and this map arrives over sync or import. Looked up on a
  // plain-object schema table it would answer `Object.prototype` — truthy,
  // with no `safeParse` — and every trust read of the document would throw.
  it('ignores a `__proto__` key in the trust map instead of throwing', () => {
    const doc = markdownDoc()
    doc.getMap('trust').set('__proto__', { polluted: true })
    doc.getMap('trust').set('generated', { ...GENERATED })
    doc.commit()

    expect(readTrustFacets(doc)).toEqual({ generated: GENERATED })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('answers undefined when every field is corrupt, rather than an empty family', () => {
    const doc = markdownDoc()
    writeTrustFacets(doc, { generated: GENERATED })
    doc.getMap('trust').set('generated', 42)
    doc.commit()

    expect(readTrustFacets(doc)).toBeUndefined()
  })

  it('converges when two peers write different fields', () => {
    const a = markdownDoc()
    const b = LoroDoc.fromSnapshot(a.export({ mode: 'snapshot' }))
    writeTrustFacets(a, { generated: GENERATED })
    // b states only `verified`; a replace-the-whole-object storage shape
    // would make one peer's field disappear on merge.
    b.getMap('trust').set('verified', [...VERIFIED])
    b.commit()

    a.import(b.export({ mode: 'update' }))
    expect(readTrustFacets(a)).toEqual({ generated: GENERATED, verified: VERIFIED })
  })
})
