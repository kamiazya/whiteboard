import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readMarkdownBody,
  readSpatialCanvas,
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  MARKDOWN_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
  nodeFile,
  nodeText,
  spatialCanvasSchema,
} from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { rewriteDocumentReferences } from './rewrite.js'
import { ReferenceRewriteTooLargeError } from './text-limit.js'

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

describe('rewriteDocumentReferences, held to the text ceilings', () => {
  const LONG = new Map([['a', `archive/${'x'.repeat(60)}`]])

  it('refuses to grow a body past the markdown ceiling, and writes nothing', () => {
    const doc = new LoroDoc()
    writeMarkdownBody(doc, '[[a]] '.repeat(Math.floor(MARKDOWN_MAX_CHARS / 12)))
    const before = doc.oplogVersion().encode()

    expect(() => rewriteDocumentReferences(doc, LONG, 'markdown')).toThrow(
      ReferenceRewriteTooLargeError,
    )
    expect(doc.oplogVersion().encode()).toEqual(before)
  })

  it('refuses a board whose rewrite grows any node past the node ceiling, and writes none of it', () => {
    const doc = new LoroDoc()
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(
      doc,
      spatialCanvasSchema.parse({
        nodes: [
          textNode({ id: 'fits', x: 0, y: 0, width: 10, height: 10, text: 'see [[a]]' }),
          textNode({
            id: 'dense',
            x: 0,
            y: 20,
            width: 10,
            height: 10,
            text: '[[a]] '.repeat(Math.floor(NODE_TEXT_MAX_CHARS / 12)),
          }),
        ],
        edges: [],
      }),
    )
    const before = doc.oplogVersion().encode()

    expect(() => rewriteDocumentReferences(doc, LONG, 'spatial')).toThrow(
      expect.objectContaining({
        breach: expect.objectContaining({ shape: 'node-text', nodeId: 'dense' }),
      }),
    )
    expect(doc.oplogVersion().encode()).toEqual(before)
  })

  it('still rewrites a body that shrinks, even one stored past the ceiling', () => {
    const doc = new LoroDoc()
    writeMarkdownBody(doc, `${'y'.repeat(MARKDOWN_MAX_CHARS)} [[design/login]]`)

    expect(rewriteDocumentReferences(doc, new Map([['design/login', 'd']]), 'markdown')).toBe(true)
    expect(readMarkdownBody(doc).endsWith('[[d]]')).toBe(true)
  })
})
