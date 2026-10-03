import {
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { extractContentFacts } from './extract.js'

function docWith(kind: 'spatial' | 'markdown' | undefined): LoroDoc {
  const doc = new LoroDoc()
  if (kind !== undefined) writeDocumentKind(doc, kind)
  writeMarkdownBody(doc, 'see [[from-the-body]]')
  writeSpatialCanvas(doc, {
    nodes: [
      textNode({ id: 'n', x: 0, y: 0, width: 10, height: 10, text: 'see [[from-the-canvas]]' }),
    ],
    edges: [],
  })
  return doc
}

const targetsOf = (entryKind: 'spatial' | 'markdown' | undefined, doc: LoroDoc) =>
  extractContentFacts({ kind: entryKind }, doc).refs.map((ref) => ref.target)

describe('extractContentFacts chooses the half a document is read as', () => {
  it('trusts the kind the document records over the index row, as readDocumentContent does', () => {
    expect(targetsOf('spatial', docWith('markdown'))).toEqual(['from-the-body'])
    expect(targetsOf('markdown', docWith('spatial'))).toEqual(['from-the-canvas'])
  })

  it('falls back to the index row for a document that records no kind', () => {
    expect(targetsOf('markdown', docWith(undefined))).toEqual(['from-the-body'])
    expect(targetsOf('spatial', docWith(undefined))).toEqual(['from-the-canvas'])
  })

  it('reads a document that names no kind anywhere as a canvas, the kind every pre-kind document was', () => {
    expect(targetsOf(undefined, docWith(undefined))).toEqual(['from-the-canvas'])
  })
})
