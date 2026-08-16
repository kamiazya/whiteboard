// A markdown document's body is stored in ONE place: the Loro text
// container named `body`. `writeMarkdownBody` is the only writer, and both
// the daemon (`wb_document_set`, the sync session's `set-body` command) and
// apps/web's browser-local editor go through it.
//
// The `okf-body` TEXT NODE is history: documents an older writer left still
// carry one, so `readMarkdownBody` falls back to it and `writeMarkdownBody`
// clears it on the next write. Nothing writes one any more — that is what
// these tests pin.
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  readMarkdownBody,
  readSpatialCanvas,
  writeMarkdownBody,
  writeSpatialCanvas,
} from './loro-bridge.js'

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

describe('writeMarkdownBody', () => {
  it('round-trips through the reader', () => {
    const doc = new LoroDoc()
    writeMarkdownBody(doc, BODY)
    expect(readMarkdownBody(doc)).toBe(BODY)
  })

  it('replaces the previous body rather than appending to it', () => {
    const doc = new LoroDoc()
    writeMarkdownBody(doc, 'first')
    writeMarkdownBody(doc, 'second')
    expect(readMarkdownBody(doc)).toBe('second')
  })

  it('clears the body when written empty', () => {
    const doc = new LoroDoc()
    writeMarkdownBody(doc, BODY)
    writeMarkdownBody(doc, '')
    expect(readMarkdownBody(doc)).toBe('')
  })

  it('writes the CONTAINER, so a markdown document is not also a spatial canvas', () => {
    // The point of the whole change. Storing a body as a text node made a
    // markdown document parse as a perfectly valid canvas holding one node,
    // which is why every reader of a reference has to ask the document its
    // kind before it can tell prose from a diagram.
    const doc = new LoroDoc()
    writeMarkdownBody(doc, BODY)
    expect(readSpatialCanvas(doc).nodes).toEqual([])
  })

  it('supersedes a legacy okf-body node left by an older writer', () => {
    // Stored documents keep their text node until something rewrites them.
    // A rewrite must not leave the old node behind to be read back later —
    // that is exactly the stale-read the two representations enabled.
    const doc = withBodyNode(new LoroDoc(), 'stale from the node')
    writeMarkdownBody(doc, 'fresh')
    expect(readMarkdownBody(doc)).toBe('fresh')
    expect(readSpatialCanvas(doc).nodes).toEqual([])
  })
})
