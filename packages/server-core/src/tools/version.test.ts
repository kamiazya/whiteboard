import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { reassembleSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FakeCanvasDocStore, seedDoc } from '../test-utils/fake-canvas-doc-store.js'
import { createVersionListTool } from './version-list.js'
import { createVersionRestoreTool } from './version-restore.js'
import { VersionNotFoundError } from './version-restore.js'
import { createVersionSaveTool } from './version-save.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

function makeDeps(canvasDocStore: FakeCanvasDocStore) {
  return { canvasDocStore, workspaceIndex: {} as never, blobStore: {} as never }
}

async function loadDoc(store: FakeCanvasDocStore, canvasId: string): Promise<LoroDoc> {
  const snapshot = await store.loadSnapshot({ docRef: { kind: 'canvas', canvasId } })
  const doc = new LoroDoc()
  if (snapshot !== null) {
    doc.import(reassembleSnapshot(snapshot.manifest, snapshot.chunks))
  }
  return doc
}

describe('version_save tool', () => {
  test('saves a version and returns metadata', async () => {
    const tool = createVersionSaveTool(makeDeps(new FakeCanvasDocStore()))

    const result = await tool.execute({ canvasId: CANVAS_ID, label: 'v1' })

    expect(result.canvasId).toBe(CANVAS_ID)
    expect(result.label).toBe('v1')
    expect(result.versionId).toBeTruthy()
    expect(result.timestamp).toBeTruthy()
    expect(result.frontier).toBeTruthy()
  })

  test('each save produces a unique versionId', async () => {
    const tool = createVersionSaveTool(makeDeps(new FakeCanvasDocStore()))

    const r1 = await tool.execute({ canvasId: CANVAS_ID, label: 'v1' })
    const r2 = await tool.execute({ canvasId: CANVAS_ID, label: 'v2' })

    expect(r1.versionId).not.toBe(r2.versionId)
  })
})

describe('version_list tool', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('returns empty list for a canvas with no versions', async () => {
    const tool = createVersionListTool(makeDeps(new FakeCanvasDocStore()))

    const result = await tool.execute({ canvasId: CANVAS_ID })

    expect(result).toEqual({ canvasId: CANVAS_ID, versions: [] })
  })

  test('lists saved versions newest-first', async () => {
    const deps = makeDeps(new FakeCanvasDocStore())
    const saveTool = createVersionSaveTool(deps)
    const listTool = createVersionListTool(deps)

    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    await saveTool.execute({ canvasId: CANVAS_ID, label: 'first' })

    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'))
    await saveTool.execute({ canvasId: CANVAS_ID, label: 'second' })

    const result = await listTool.execute({ canvasId: CANVAS_ID })

    expect(result.versions).toHaveLength(2)
    expect(result.versions[0].label).toBe('second')
    expect(result.versions[1].label).toBe('first')
  })
})

describe('version_restore tool', () => {
  test('restores spatial canvas content from a saved version', async () => {
    const store = new FakeCanvasDocStore()
    const deps = makeDeps(store)
    const saveTool = createVersionSaveTool(deps)
    const restoreTool = createVersionRestoreTool(deps)

    await seedDoc(store, CANVAS_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'original' }],
        edges: [],
      })
    })

    const saved = await saveTool.execute({ canvasId: CANVAS_ID, label: 'before-edit' })

    const doc = await loadDoc(store, CANVAS_ID)
    writeSpatialCanvas(doc, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'modified' }],
      edges: [],
    })
    doc.commit()
    const { chunkSnapshot } = await import('@kamiazya/whiteboard-canvas-ports')
    const { manifest, chunks } = chunkSnapshot(doc.export({ mode: 'snapshot' }), 1_000_000)
    await store.saveSnapshot({
      docRef: { kind: 'canvas', canvasId: CANVAS_ID },
      manifest,
      chunks,
      frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
    })

    const beforeRestore = await loadDoc(store, CANVAS_ID)
    const beforeCanvas = readSpatialCanvas(beforeRestore)
    expect(beforeCanvas.nodes[0].text).toBe('modified')

    const result = await restoreTool.execute({
      canvasId: CANVAS_ID,
      versionId: saved.versionId,
    })

    expect(result.restoredVersionId).toBe(saved.versionId)
    expect(result.label).toBe('before-edit')

    const afterRestore = await loadDoc(store, CANVAS_ID)
    const afterCanvas = readSpatialCanvas(afterRestore)
    expect(afterCanvas.nodes[0].text).toBe('original')
  })

  test('throws VersionNotFoundError for unknown versionId', async () => {
    const deps = makeDeps(new FakeCanvasDocStore())
    const restoreTool = createVersionRestoreTool(deps)

    await expect(
      restoreTool.execute({ canvasId: CANVAS_ID, versionId: 'nonexistent' }),
    ).rejects.toThrow(VersionNotFoundError)
  })
})
