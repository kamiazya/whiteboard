// A markdown document's body has TWO stored representations in this
// codebase, and until now no reader knew about both:
//
//   - mcp-server / the daemon store it as a single `okf-body` text node
//     inside the spatial canvas (what `wb_document_set` writes).
//   - apps/web's browser-local editor stores it in a Loro text container
//     named `body`.
//
// Neither side could read the other's documents. This is the one reader
// that answers "what is this document's body" for both, so a caller does
// not have to know which side wrote it.
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { readMarkdownBody, writeSpatialCanvas } from './loro-bridge.js'

const BODY = '# Weekly notes\n\nShipped the markdown file node.'

/** The shape `wb_document_set` writes. */
function withBodyNode(doc: LoroDoc, text: string): LoroDoc {
  writeSpatialCanvas(doc, {
    nodes: [{ id: 'okf-body', type: 'text', x: 0, y: 0, width: 600, height: 400, text }],
    edges: [],
  })
  return doc
}

/** The shape apps/web's browser-local markdown editor writes. */
function withBodyContainer(doc: LoroDoc, text: string): LoroDoc {
  doc.getText('body').insert(0, text)
  doc.commit()
  return doc
}

describe('readMarkdownBody', () => {
  it('reads the body text container', () => {
    expect(readMarkdownBody(withBodyContainer(new LoroDoc(), BODY))).toBe(BODY)
  })

  it('reads the okf-body text node', () => {
    expect(readMarkdownBody(withBodyNode(new LoroDoc(), BODY))).toBe(BODY)
  })

  it('falls back to the first text node for a document written before the id was stable', () => {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, {
      nodes: [{ id: 'legacy', type: 'text', x: 0, y: 0, width: 600, height: 400, text: BODY }],
      edges: [],
    })
    expect(readMarkdownBody(doc)).toBe(BODY)
  })

  it('prefers the text container when a document somehow carries both', () => {
    // Not a shape anything writes today. Fixed anyway, because "whichever
    // the reader happened to check first" is not an answer, and the
    // container is the live-edited one wherever both exist.
    const doc = withBodyNode(new LoroDoc(), 'from the node')
    withBodyContainer(doc, 'from the container')
    expect(readMarkdownBody(doc)).toBe('from the container')
  })

  it('answers with the empty string for a document with no body at all', () => {
    expect(readMarkdownBody(new LoroDoc())).toBe('')
  })

  it('ignores a non-text node when looking for the body', () => {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, {
      nodes: [{ id: 'okf-body', type: 'file', x: 0, y: 0, width: 10, height: 10, file: 'x' }],
      edges: [],
    })
    expect(readMarkdownBody(doc)).toBe('')
  })
})
