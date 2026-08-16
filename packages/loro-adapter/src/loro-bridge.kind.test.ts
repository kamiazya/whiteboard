import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { readDocumentKind, writeDocumentKind } from './loro-bridge.js'

/**
 * A document has to say what it is. Before this, nothing in the Loro doc
 * did: both exporters ran on any document, and `wb_document_get` had
 * nothing to branch on (ADR-0009 decision 4).
 */
describe('document kind bridge', () => {
  test('a fresh doc has no kind — absent is not a default', () => {
    expect(readDocumentKind(new LoroDoc())).toBeUndefined()
  })

  test.each<DocumentKind>(['spatial', 'markdown'])('round-trips %s', (kind) => {
    const doc = new LoroDoc()
    writeDocumentKind(doc, kind)
    expect(readDocumentKind(doc)).toBe(kind)
  })

  test('an unrecognised stored value reads as undefined rather than throwing', () => {
    // The map is a CRDT: a peer on a newer version can write a kind this
    // build has never heard of. Dropping to undefined lets the caller fail
    // with its own message instead of a parse error from three layers down.
    const doc = new LoroDoc()
    doc.getMap('document').set('kind', 'hologram')
    doc.commit()
    expect(readDocumentKind(doc)).toBeUndefined()
  })

  test('survives a CRDT merge', () => {
    const a = new LoroDoc()
    writeDocumentKind(a, 'markdown')
    const b = new LoroDoc()
    b.import(a.export({ mode: 'snapshot' }))
    expect(readDocumentKind(b)).toBe('markdown')
  })
})
