import { reassembleSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import { readFacets, readSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  FakeCanvasDocStore,
  registerCanvasInWorkspace,
} from '../test-utils/fake-canvas-doc-store.js'
import { createCanvasImportOkfTool } from './canvas-import-okf.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(canvasDocStore: FakeCanvasDocStore) {
  return { canvasDocStore, blobStore: {} as never }
}

async function loadDoc(store: FakeCanvasDocStore, canvasId: string): Promise<LoroDoc> {
  const snap = await store.loadSnapshot({ docRef: { kind: 'canvas', canvasId } })
  if (!snap) throw new Error('no snapshot')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(snap.manifest, snap.chunks))
  return doc
}

describe('wb_document_set tool', () => {
  test('imports markdown with facets and body into a new LoroDoc', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const tool = createCanvasImportOkfTool(makeDeps(store))

    const markdown = [
      '---',
      'type: issue',
      'facets:',
      '  issue/1:',
      '    status: open',
      '    priority: high',
      '---',
      '# Bug report',
      '',
      'Something is broken.',
    ].join('\n')

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, markdown })

    expect(result.canvasId).toBe(CANVAS_ID)
    expect(result.imported).toBe(true)

    const doc = await loadDoc(store, CANVAS_ID)
    const facets = readFacets(doc)
    expect(facets).toEqual({ 'issue/1': { status: 'open', priority: 'high' } })

    const canvas = readSpatialCanvas(doc)
    expect(canvas.nodes).toHaveLength(1)
    expect(canvas.nodes[0].type).toBe('text')
    if (canvas.nodes[0].type === 'text') {
      expect(canvas.nodes[0].text).toBe('# Bug report\n\nSomething is broken.')
    }
  })

  test('imports markdown with empty body (facets only)', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const tool = createCanvasImportOkfTool(makeDeps(store))

    const markdown = '---\ntype: note\n---\n'

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, markdown })

    expect(result.imported).toBe(true)

    const doc = await loadDoc(store, CANVAS_ID)
    const canvas = readSpatialCanvas(doc)
    expect(canvas.nodes).toHaveLength(0)
  })

  test('overwrites existing doc on re-import', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const tool = createCanvasImportOkfTool(makeDeps(store))

    const v1 = '---\ntype: issue\nfacets:\n  issue/1:\n    status: open\n---\nFirst body.'
    await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, markdown: v1 })

    const v2 = '---\ntype: issue\nfacets:\n  issue/1:\n    status: closed\n---\nUpdated body.'
    await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, markdown: v2 })

    const doc = await loadDoc(store, CANVAS_ID)
    const facets = readFacets(doc)
    expect(facets['issue/1']).toEqual({ status: 'closed' })

    const canvas = readSpatialCanvas(doc)
    expect(canvas.nodes).toHaveLength(1)
    if (canvas.nodes[0].type === 'text') {
      expect(canvas.nodes[0].text).toBe('Updated body.')
    }
  })

  test('rejects invalid OKF markdown', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    const tool = createCanvasImportOkfTool(makeDeps(store))

    await expect(
      tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, markdown: 'no frontmatter' }),
    ).rejects.toThrow()
  })

  test('rejects when canvas is not in workspace', async () => {
    const store = new FakeCanvasDocStore()
    const tool = createCanvasImportOkfTool(makeDeps(store))

    const markdown = '---\ntype: note\n---\nBody.'

    await expect(
      tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, markdown }),
    ).rejects.toThrow()
  })
})
