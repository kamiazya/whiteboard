import {
  setEdgeLock,
  setNodeLock,
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore, seedDoc } from '../test-utils/fake-document-store.js'
import {
  canvasSnapshotSchema,
  createCanvasSnapshotTool,
  SNAPSHOT_MAX_EDGES,
  SNAPSHOT_MAX_NODES,
  SNAPSHOT_TEXT_MAX_CHARS,
} from './canvas-snapshot.js'
import { SnapshotNotFoundError } from './document-io.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(documentStore: FakeDocumentStore) {
  return { documentStore, blobStore: {} as never, documentIndex: documentStore.documentIndex }
}

describe('wb_canvas_snapshot tool', () => {
  test('projects every node kind, its geometry and its edges to a pinned literal', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [
          { id: 'n1', type: 'text', x: 0, y: 0, width: 200, height: 60, text: 'Hello', color: '4' },
          { id: 'n2', type: 'group', x: -10, y: -10, width: 400, height: 300, label: 'Phase 1' },
          {
            id: 'n3',
            type: 'link',
            x: 0,
            y: 100,
            width: 200,
            height: 60,
            url: 'https://a.example',
          },
          { id: 'n4', type: 'file', x: 0, y: 200, width: 200, height: 60, file: 'notes.md' },
        ],
        edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n3', label: 'leads to' }],
      })
    })
    const tool = createCanvasSnapshotTool(makeDeps(store))

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    // Pinned as a whole-object literal rather than field spot-checks: this
    // payload is what an agent reads a board through, so an accidental
    // extra or dropped field is exactly the regression worth catching.
    expect(result).toEqual({
      documentId: DOCUMENT_ID,
      nodes: [
        { id: 'n1', type: 'text', x: 0, y: 0, width: 200, height: 60, text: 'Hello', color: '4' },
        { id: 'n2', type: 'group', x: -10, y: -10, width: 400, height: 300, label: 'Phase 1' },
        { id: 'n3', type: 'link', x: 0, y: 100, width: 200, height: 60, url: 'https://a.example' },
        { id: 'n4', type: 'file', x: 0, y: 200, width: 200, height: 60, file: 'notes.md' },
      ],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n3', label: 'leads to' }],
      nodeCount: 4,
      edgeCount: 1,
      truncated: false,
    })
    expect(() => canvasSnapshotSchema.parse(result)).not.toThrow()
  })

  test('reports lock state, and only for the locked elements', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [
          { id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'a' },
          { id: 'n2', type: 'text', x: 0, y: 20, width: 10, height: 10, text: 'b' },
        ],
        edges: [
          { id: 'e1', fromNode: 'n1', toNode: 'n2' },
          { id: 'e2', fromNode: 'n2', toNode: 'n1' },
        ],
      })
      setNodeLock(doc, 'n1', true)
      setEdgeLock(doc, 'e2', true)
    })
    const tool = createCanvasSnapshotTool(makeDeps(store))

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    // `locked` is omitted rather than emitted as `false`: this payload is
    // sized for an agent's context window, and the unlocked case is the
    // overwhelming majority of every board.
    expect(result.nodes.find((n) => n.id === 'n1')?.locked).toBe(true)
    expect(result.nodes.find((n) => n.id === 'n2')).not.toHaveProperty('locked')
    expect(result.edges.find((e) => e.id === 'e2')?.locked).toBe(true)
    expect(result.edges.find((e) => e.id === 'e1')).not.toHaveProperty('locked')
  })

  test('truncates an over-long node text, flags that node, and keeps the prefix exact', async () => {
    const store = new FakeDocumentStore()
    const longText = 'x'.repeat(SNAPSHOT_TEXT_MAX_CHARS + 50)
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [
          { id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: longText },
          { id: 'n2', type: 'text', x: 0, y: 20, width: 10, height: 10, text: 'short' },
        ],
        edges: [],
      })
    })
    const tool = createCanvasSnapshotTool(makeDeps(store))

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    const cut = result.nodes[0]
    expect(cut.text).toBe(longText.slice(0, SNAPSHOT_TEXT_MAX_CHARS))
    expect(cut.textTruncated).toBe(true)
    // No ellipsis is appended: the value stays an exact prefix of the real
    // text, so an agent can match it against what it wrote.
    expect(cut.text).toHaveLength(SNAPSHOT_TEXT_MAX_CHARS)
    expect(result.nodes[1]).not.toHaveProperty('textTruncated')
    expect(result.truncated).toBe(true)
  })

  test('caps a large board but still reports the true totals', async () => {
    const store = new FakeDocumentStore()
    const nodes: SpatialNode[] = Array.from({ length: SNAPSHOT_MAX_NODES + 5 }, (_, i) => ({
      id: `n${i}`,
      type: 'text' as const,
      x: i,
      y: 0,
      width: 10,
      height: 10,
      text: `t${i}`,
    }))
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, { nodes, edges: [] })
    })
    const tool = createCanvasSnapshotTool(makeDeps(store))

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    expect(result.nodes).toHaveLength(SNAPSHOT_MAX_NODES)
    // The count is the REAL total, not the returned length — a cap that
    // lies about how much it hid is worse than no cap, because an agent
    // then believes it has read the whole board.
    expect(result.nodeCount).toBe(SNAPSHOT_MAX_NODES + 5)
    expect(result.truncated).toBe(true)
    expect(result.nodes[0].id).toBe('n0')
  })

  test('caps edges independently of nodes', async () => {
    const store = new FakeDocumentStore()
    const edges = Array.from({ length: SNAPSHOT_MAX_EDGES + 3 }, (_, i) => ({
      id: `e${i}`,
      fromNode: 'n1',
      toNode: 'n2',
    }))
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [
          { id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'a' },
          { id: 'n2', type: 'text', x: 0, y: 20, width: 10, height: 10, text: 'b' },
        ],
        edges,
      })
    })
    const tool = createCanvasSnapshotTool(makeDeps(store))

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    expect(result.edges).toHaveLength(SNAPSHOT_MAX_EDGES)
    expect(result.edgeCount).toBe(SNAPSHOT_MAX_EDGES + 3)
    expect(result.nodes).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  test('refuses a markdown document instead of snapshotting its empty spatial containers', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeMarkdownBody(doc, '# Real prose\n\nThis document is not empty.')
    })
    const tool = createCanvasSnapshotTool(makeDeps(store))

    await expect(
      tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }),
    ).rejects.toMatchObject({
      name: 'NotASpatialDocumentError',
      message: expect.stringMatching(/markdown.*wb_document_get/s),
    })
  })

  test('rejects when the canvas has no stored snapshot', async () => {
    const tool = createCanvasSnapshotTool(makeDeps(new FakeDocumentStore()))

    await expect(
      tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }),
    ).rejects.toThrow(SnapshotNotFoundError)
  })
})
