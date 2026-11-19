import { nodeText, spatialCanvasSchema, withNodeText } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { applyDocumentEdit } from './document-edit.js'
import { readSpatialCanvas, writeSpatialCanvas } from './loro-bridge.js'
import { readMarkdownBody, writeMarkdownBody } from './markdown-body.js'

describe('applyDocumentEdit', () => {
  it('applies splice runs given in descending order against the offsets they were planned on', () => {
    const doc = new LoroDoc()
    writeMarkdownBody(doc, 'aa bb cc')
    applyDocumentEdit(doc, {
      kind: 'markdown-splices',
      runs: [
        { index: 6, remove: 2, insert: 'CC!' },
        { index: 0, remove: 2, insert: 'A' },
      ],
    })
    expect(readMarkdownBody(doc)).toBe('A bb CC!')
  })

  it('commits a splice edit once, however many runs it carries', () => {
    const doc = new LoroDoc()
    writeMarkdownBody(doc, 'a b')
    let commits = 0
    doc.subscribeLocalUpdates(() => commits++)
    applyDocumentEdit(doc, {
      kind: 'markdown-splices',
      runs: [
        { index: 2, remove: 1, insert: 'B' },
        { index: 0, remove: 1, insert: 'A' },
      ],
    })
    expect(commits).toBe(1)
  })

  it('replaces a body as a minimal change, not a whole-text rewrite', () => {
    const doc = new LoroDoc()
    writeMarkdownBody(doc, 'keep this, change that, keep the rest')
    const opCount = () => doc.oplogVersion().toJSON().get(doc.peerIdStr) ?? 0
    const opsBefore = opCount()
    applyDocumentEdit(doc, {
      kind: 'markdown-body',
      body: 'keep this, CHANGED that, keep the rest',
    })
    expect(readMarkdownBody(doc)).toBe('keep this, CHANGED that, keep the rest')
    // One insert of the changed span, its 8 units, not the body deleted and written again.
    expect(opCount() - opsBefore).toBeLessThan(20)
  })

  it('writes only the nodes it names and leaves a sibling node untouched', () => {
    const doc = new LoroDoc()
    const a = textNode({ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'one' })
    const b = textNode({ id: 'b', x: 0, y: 20, width: 10, height: 10, text: 'two' })
    writeSpatialCanvas(doc, spatialCanvasSchema.parse({ nodes: [a, b], edges: [] }))
    applyDocumentEdit(doc, {
      kind: 'spatial-nodes',
      nodes: [withNodeText(a, 'ONE')],
    })
    const canvas = readSpatialCanvas(doc)
    expect(canvas.nodes.map((n) => nodeText(n))).toEqual(['ONE', 'two'])
  })

  it('reconciles a canvas against the one the plan was made from', () => {
    const doc = new LoroDoc()
    const a = textNode({ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'one' })
    const before = spatialCanvasSchema.parse({ nodes: [a], edges: [], tags: ['t'] })
    writeSpatialCanvas(doc, before)
    const after = spatialCanvasSchema.parse({ ...before, nodes: [withNodeText(a, 'ONE')] })
    applyDocumentEdit(doc, { kind: 'spatial-canvas', before, after })
    const read = readSpatialCanvas(doc)
    expect(read.tags).toEqual(['t'])
    expect(nodeText(read.nodes[0]!)).toBe('ONE')
  })
})
