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
import {
  canvasWithMarkdownBody,
  markdownBodyFromCanvas,
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

const bodyNode = (text: string) =>
  ({ id: 'okf-body', type: 'text', x: 0, y: 0, width: 600, height: 400, text }) as const

describe('markdownBodyFromCanvas', () => {
  it('reads the okf-body text node', () => {
    expect(markdownBodyFromCanvas({ nodes: [bodyNode(BODY)], edges: [] })).toBe(BODY)
  })

  it('falls back to the first text node for a document written before the id was stable', () => {
    const legacy = { ...bodyNode(BODY), id: 'legacy' }
    expect(markdownBodyFromCanvas({ nodes: [legacy], edges: [] })).toBe(BODY)
  })

  it('answers with the empty string for a canvas with no text node', () => {
    expect(markdownBodyFromCanvas({ nodes: [], edges: [] })).toBe('')
  })
})

describe('canvasWithMarkdownBody', () => {
  it('replaces the body node text, preserving its geometry', () => {
    const before = { nodes: [{ ...bodyNode('old'), x: 40, width: 320 }], edges: [] }
    const { canvas, node, created } = canvasWithMarkdownBody(before, 'new body')
    expect(created).toBe(false)
    expect(node).toEqual({ ...bodyNode('new body'), x: 40, width: 320 })
    expect(canvas.nodes).toEqual([node])
    // Immutable update: the input canvas is untouched.
    expect(before.nodes[0]?.text).toBe('old')
  })

  it('targets the first text node in a legacy document without the stable id', () => {
    const legacy = { ...bodyNode('old'), id: 'legacy' }
    const { canvas, node, created } = canvasWithMarkdownBody({ nodes: [legacy], edges: [] }, 'new')
    expect(created).toBe(false)
    expect(node.id).toBe('legacy')
    expect(canvas.nodes[0]?.type === 'text' && canvas.nodes[0].text).toBe('new')
  })

  it('creates the okf-body node when the document has none', () => {
    const { canvas, node, created } = canvasWithMarkdownBody({ nodes: [], edges: [] }, BODY)
    expect(created).toBe(true)
    expect(node).toEqual(bodyNode(BODY))
    expect(canvas.nodes).toEqual([node])
  })

  it('round-trips through markdownBodyFromCanvas', () => {
    const { canvas } = canvasWithMarkdownBody({ nodes: [], edges: [] }, BODY)
    expect(markdownBodyFromCanvas(canvas)).toBe(BODY)
  })

  it('replaces a non-text node squatting on the reserved id instead of duplicating it', () => {
    // Mirrors the read path's 'ignores a non-text node' case: a file node
    // holding okf-body is unreadable as a body, and the write must not
    // produce two nodes with one id (keyed persistence would drop one).
    const squatter = {
      id: 'okf-body',
      type: 'file',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      file: 'x',
    } as const
    const { canvas, node, created } = canvasWithMarkdownBody({ nodes: [squatter], edges: [] }, BODY)
    expect(created).toBe(true)
    expect(canvas.nodes).toEqual([node])
    expect(markdownBodyFromCanvas(canvas)).toBe(BODY)
  })
})
