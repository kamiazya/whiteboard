import { readFacets } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { FakeCanvasDocStore } from '../test-utils/fake-canvas-doc-store.js'
import { createFacetSetTool, facetSetInputSchema } from './facet-set.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

describe('facet_set tool', () => {
  test('sets a facet on a canvas with no prior snapshot', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    const tool = createFacetSetTool({
      canvasDocStore,
      workspaceIndex: {} as never,
      blobStore: {} as never,
    })

    const result = await tool.execute({
      canvasId: CANVAS_ID,
      facets: { 'kanban/1': { status: 'todo' } },
    })

    expect(result).toEqual({
      canvasId: CANVAS_ID,
      facets: { 'kanban/1': { status: 'todo' } },
    })
  })

  test('persists the facet so a later load reflects it', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    const tool = createFacetSetTool({
      canvasDocStore,
      workspaceIndex: {} as never,
      blobStore: {} as never,
    })

    await tool.execute({ canvasId: CANVAS_ID, facets: { 'kanban/1': { status: 'todo' } } })

    const loaded = await canvasDocStore.loadSnapshot({
      docRef: { kind: 'canvas', canvasId: CANVAS_ID },
    })
    expect(loaded).not.toBeNull()
    const doc = new LoroDoc()
    if (loaded !== null) {
      const bytes = new Uint8Array(loaded.manifest.totalBytes)
      let offset = 0
      for (const chunk of loaded.chunks) {
        bytes.set(chunk.bytes, offset)
        offset += chunk.bytes.byteLength
      }
      doc.import(bytes)
    }
    expect(readFacets(doc)).toEqual({ 'kanban/1': { status: 'todo' } })
  })

  test('merges a new facet domain with an existing one instead of replacing it', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    const tool = createFacetSetTool({
      canvasDocStore,
      workspaceIndex: {} as never,
      blobStore: {} as never,
    })

    await tool.execute({ canvasId: CANVAS_ID, facets: { 'kanban/1': { status: 'todo' } } })
    const result = await tool.execute({
      canvasId: CANVAS_ID,
      facets: { 'priority/1': { level: 'high' } },
    })

    expect(result.facets).toEqual({
      'kanban/1': { status: 'todo' },
      'priority/1': { level: 'high' },
    })
  })

  test('overwrites an existing facet domain when the same key is set again', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    const tool = createFacetSetTool({
      canvasDocStore,
      workspaceIndex: {} as never,
      blobStore: {} as never,
    })

    await tool.execute({ canvasId: CANVAS_ID, facets: { 'kanban/1': { status: 'todo' } } })
    const result = await tool.execute({
      canvasId: CANVAS_ID,
      facets: { 'kanban/1': { status: 'done' } },
    })

    expect(result.facets).toEqual({ 'kanban/1': { status: 'done' } })
  })

  test('rejects a facet key outside the {domain}/{version} pattern', () => {
    expect(() =>
      facetSetInputSchema.parse({
        canvasId: CANVAS_ID,
        facets: { title: 'not an extension facet' },
      }),
    ).toThrow()
  })
})
