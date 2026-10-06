import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readMarkdownBody,
  readSpatialCanvas,
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { nodeFile, nodeText, spatialCanvasSchema } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { rewriteDocumentReferences } from './rewrite.js'

const PLAN = new Map([['design/login', 'archive/login']])

describe('rewriteDocumentReferences', () => {
  it("repoints a note's references and leaves the rest of its body as written", () => {
    const doc = new LoroDoc()
    writeMarkdownBody(doc, 'see [[design/login]] and [[unrelated]]')

    expect(rewriteDocumentReferences(doc, PLAN, 'markdown')).toBe(true)
    expect(readMarkdownBody(doc)).toBe('see [[archive/login]] and [[unrelated]]')
  })

  it('answers false and writes nothing when the document names no moved alias', () => {
    const doc = new LoroDoc()
    writeMarkdownBody(doc, 'see [[unrelated]]')
    const before = doc.oplogVersion().encode()

    expect(rewriteDocumentReferences(doc, PLAN, 'markdown')).toBe(false)
    expect(doc.oplogVersion().encode()).toEqual(before)
  })

  it("repoints a board's text and file nodes", () => {
    const doc = new LoroDoc()
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(
      doc,
      spatialCanvasSchema.parse({
        nodes: [
          textNode({ id: 't', x: 0, y: 0, width: 100, height: 40, text: 'see [[design/login]]' }),
          fileNode({ id: 'f', x: 0, y: 60, width: 100, height: 40, file: 'design/login' }),
        ],
        edges: [],
      }),
    )

    expect(rewriteDocumentReferences(doc, PLAN, 'spatial')).toBe(true)
    const canvas = readSpatialCanvas(doc)
    const byId = (id: string) => canvas.nodes.find((node) => node.id === id)
    expect(nodeText(byId('t') ?? canvas.nodes[0]!)).toBe('see [[archive/login]]')
    expect(nodeFile(byId('f') ?? canvas.nodes[0]!)).toBe('archive/login')
  })

  it('answers false and writes nothing when a board names no moved alias', () => {
    const doc = new LoroDoc()
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(
      doc,
      spatialCanvasSchema.parse({
        nodes: [textNode({ id: 't', x: 0, y: 0, width: 100, height: 40, text: 'see [[other]]' })],
        edges: [],
      }),
    )
    const before = doc.oplogVersion().encode()

    expect(rewriteDocumentReferences(doc, PLAN, 'spatial')).toBe(false)
    expect(doc.oplogVersion().encode()).toEqual(before)
  })

  // A document written before kinds existed records none, and neither does
  // its row; the rest of the system reads it as a canvas, so the rewrite
  // must too — a markdown write over it would replace its nodes with a body.
  it('repoints a board that records no kind, as the canvas it reads as', () => {
    const doc = new LoroDoc()
    writeSpatialCanvas(
      doc,
      spatialCanvasSchema.parse({
        nodes: [
          textNode({ id: 't', x: 0, y: 0, width: 100, height: 40, text: 'see [[design/login]]' }),
        ],
        edges: [],
      }),
    )

    expect(rewriteDocumentReferences(doc, PLAN, undefined)).toBe(true)
    const [node] = readSpatialCanvas(doc).nodes
    expect(node === undefined ? undefined : nodeText(node)).toBe('see [[archive/login]]')
  })

  // The browser keeps every document as a node of one workspace record, so
  // the rewrite has to land in that node rather than in a standalone copy.
  it('rewrites a document held as a node of a workspace record', () => {
    const workspace = new LoroDoc()
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    createWorkspaceDocumentAtPath(workspace, { path: 'daily', documentId: id, kind: 'markdown' })
    writeMarkdownBody(documentContainers(workspace, id), 'see [[design/login]]')

    expect(rewriteDocumentReferences(documentContainers(workspace, id), PLAN, 'markdown')).toBe(
      true,
    )
    expect(readMarkdownBody(documentContainers(workspace, id))).toBe('see [[archive/login]]')
  })
})
