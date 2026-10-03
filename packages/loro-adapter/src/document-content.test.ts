import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { readDocumentContent } from './document-content.js'
import { writeDocumentKind } from './document-envelope.js'
import { readSpatialCanvas, writeSpatialCanvas } from './loro-bridge.js'
import { writeMarkdownBody } from './markdown-body.js'

function docWith(kind: 'spatial' | 'markdown' | undefined): LoroDoc {
  const doc = new LoroDoc()
  if (kind !== undefined) writeDocumentKind(doc, kind)
  writeMarkdownBody(doc, '# body')
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 10, height: 10, text: 'hi' })],
    edges: [],
  })
  return doc
}

describe('readDocumentContent', () => {
  test('a document with no kind anywhere reads as spatial, the kind every pre-kind document was', () => {
    const doc = docWith(undefined)
    expect(readDocumentContent(doc)).toEqual({ kind: 'spatial', canvas: readSpatialCanvas(doc) })
  })

  test('the index row kind decides when the document records none', () => {
    expect(readDocumentContent(docWith(undefined), 'markdown').kind).toBe('markdown')
    expect(readDocumentContent(docWith(undefined), 'spatial').kind).toBe('spatial')
  })

  test('the document own recorded kind wins over the index row', () => {
    expect(readDocumentContent(docWith('markdown'), 'spatial').kind).toBe('markdown')
    expect(readDocumentContent(docWith('spatial'), 'markdown').kind).toBe('spatial')
  })

  test('markdown content is the body and spatial content is the canvas, never both', () => {
    const md = readDocumentContent(docWith('markdown'))
    expect(md).toEqual({ kind: 'markdown', body: '# body' })
    const sp = readDocumentContent(docWith('spatial'))
    expect(Object.keys(sp).sort()).toEqual(['canvas', 'kind'])
  })

  test('an unrecognised stored kind falls through to the index row, then to spatial', () => {
    const doc = docWith(undefined)
    doc.getMap('document').set('kind', 'hologram')
    doc.commit()
    expect(readDocumentContent(doc, 'markdown').kind).toBe('markdown')
    expect(readDocumentContent(doc).kind).toBe('spatial')
  })
})
