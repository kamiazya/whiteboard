import { sceneDigestSchema } from '@kamiazya/whiteboard-canvas-render'
import {
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore, seedDoc } from '../test-utils/fake-document-store.js'
import { createCanvasDigestTool } from './canvas-digest.js'
import { SnapshotNotFoundError } from './document-io.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(documentStore: FakeDocumentStore) {
  return { documentStore, blobStore: {} as never, documentIndex: documentStore.documentIndex }
}

describe('wb_scene_digest tool', () => {
  test('digests an overlapping two-node canvas to a pinned literal', async () => {
    const store = new FakeDocumentStore()
    const canvas = {
      nodes: [
        { id: 'n1', type: 'group' as const, x: 0, y: 0, width: 100, height: 100 },
        { id: 'n2', type: 'group' as const, x: 50, y: 50, width: 100, height: 100 },
      ],
      edges: [],
    }
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, canvas)
    })
    const tool = createCanvasDigestTool(makeDeps(store))

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    // Pinned explicitly (not computed by calling composeCanvasScene again)
    // so a real scene regression actually turns this test red — an
    // expectation computed via the tool's own producer can never fail when
    // that producer changes. Unlabelled groups emit a single chrome shape
    // at their own bbox and no label run, so the entry count here is the
    // same one an agent saw before the digest started naming entries by
    // document node id; only the names changed, from positional `n0`/`n1`
    // to the canvas's own `n1`/`n2`.
    expect(result).toEqual({
      nodes: [
        { id: 'n1', bbox: { x: 0, y: 0, w: 100, h: 100 }, z: 0 },
        { id: 'n2', bbox: { x: 50, y: 50, w: 100, h: 100 }, z: 1 },
      ],
      overlaps: [['n1', 'n2']],
      containment: [],
      clusters: [['n1', 'n2']],
      freeRegions: [
        { x: 100, y: 0, w: 60, h: 20 },
        { x: 100, y: 20, w: 60, h: 20 },
        { x: 0, y: 100, w: 40, h: 20 },
        { x: 0, y: 120, w: 40, h: 20 },
        { x: 0, y: 140, w: 40, h: 20 },
      ],
    })
    expect(result.overlaps.length).toBeGreaterThan(0)
    expect(() => sceneDigestSchema.parse(result)).not.toThrow()
  })

  test('refuses a markdown document instead of digesting its empty spatial containers', async () => {
    // A markdown document's body lives outside the nodes/edges containers,
    // so digesting them silently answered { nodes: [], edges: [] } — which
    // an auditor cannot tell apart from a genuinely empty spatial canvas.
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeMarkdownBody(doc, '# Real prose\n\nThis document is not empty.')
    })
    const tool = createCanvasDigestTool(makeDeps(store))

    await expect(
      tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }),
    ).rejects.toMatchObject({
      name: 'NotASpatialDocumentError',
      message: expect.stringMatching(/markdown.*wb_document_get/s),
    })
  })

  test('refuses when only the index row records the markdown kind (legacy doc bytes)', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeMarkdownBody(doc, 'row-kind only')
    })
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      path: 'legacy-md',
      kind: 'markdown',
    })
    const tool = createCanvasDigestTool(makeDeps(store))

    await expect(
      tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }),
    ).rejects.toMatchObject({ name: 'NotASpatialDocumentError' })
  })

  test('still digests a document with no recorded kind anywhere (legacy spatial)', async () => {
    // Pre-kind spatial documents must keep digesting — the guard refuses
    // only a KNOWN markdown document, never an unknown one.
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'n1', type: 'group' as const, x: 0, y: 0, width: 10, height: 10 }],
        edges: [],
      })
    })
    const tool = createCanvasDigestTool(makeDeps(store))

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })
    expect(result.nodes).toHaveLength(1)
  })

  test('rejects when the canvas has no stored snapshot', async () => {
    const tool = createCanvasDigestTool(makeDeps(new FakeDocumentStore()))

    await expect(
      tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }),
    ).rejects.toThrow(SnapshotNotFoundError)
  })
})
