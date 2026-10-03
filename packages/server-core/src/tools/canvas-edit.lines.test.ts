// Line ops of `wb_canvas_edit`, and the rule that ink a batch never names survives the save.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, makeDeps, seedCanvas, WORKSPACE_ID } from './_test-canvas-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'
import { loadDocument } from './document-io.js'

/**
 * A LINE is ink, not a relation
 * ([ADR-0038](../../../../docs/contributing/adr/0038-ocif-projection.md)
 * decision 2), so it is the one element that may end nowhere. The model has
 * held one since the split; these are the ops that let anything but the
 * editor author one.
 */
describe('wb_canvas_edit — line ops', () => {
  const ONE_BOX: SpatialCanvas = {
    nodes: [textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text: 'A' })],
    edges: [],
  }

  test('line.add draws ink between two bare points, which no edge can express', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, ONE_BOX)
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          op: 'line.add',
          line: {
            id: 'l1',
            from: { kind: 'point', point: { x: 10, y: 10 } },
            to: { kind: 'point', point: { x: 90, y: 90 } },
          },
        },
      ],
    })

    expect(result.applied).toBe(1)
    expect(result.touched.lines).toEqual(['l1'])
    const stored = (await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)).canvas
    expect(stored?.lines).toEqual([
      {
        id: 'l1',
        from: { kind: 'point', point: { x: 10, y: 10 } },
        to: { kind: 'point', point: { x: 90, y: 90 } },
      },
    ])
  })

  test('line.add may anchor one end to a node and leave the other free', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, ONE_BOX)
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          op: 'line.add',
          line: {
            id: 'l1',
            from: { kind: 'node', node: 'a' },
            to: { kind: 'point', point: { x: 300, y: 300 } },
          },
        },
      ],
    })

    const stored = (await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)).canvas
    expect(stored?.lines?.[0]?.from).toEqual({ kind: 'node', node: 'a' })
  })

  test('a line end naming a node that is not on the canvas is refused', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, ONE_BOX)
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [
          {
            op: 'line.add',
            line: {
              id: 'l1',
              from: { kind: 'node', node: 'ghost' },
              to: { kind: 'point', point: { x: 1, y: 1 } },
            },
          },
        ],
      }),
    ).rejects.toThrow(/ghost/)
  })

  test('line.patch moves an end, and line.remove takes the ink away', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      ...ONE_BOX,
      lines: [
        {
          id: 'l1',
          from: { kind: 'point', point: { x: 0, y: 0 } },
          to: { kind: 'point', point: { x: 1, y: 1 } },
        },
      ],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'line.patch', id: 'l1', patch: { to: { kind: 'node', node: 'a' } } }],
    })
    const patched = (await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)).canvas
    expect(patched?.lines?.[0]?.to).toEqual({ kind: 'node', node: 'a' })

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'line.remove', id: 'l1' }],
    })
    const removed = (await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)).canvas
    expect(removed?.lines ?? []).toEqual([])
  })

  test('removing a node takes the lines anchored to it, and leaves free ink alone', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      ...ONE_BOX,
      lines: [
        {
          id: 'anchored',
          from: { kind: 'node', node: 'a' },
          to: { kind: 'point', point: { x: 5, y: 5 } },
        },
        {
          id: 'free',
          from: { kind: 'point', point: { x: 0, y: 0 } },
          to: { kind: 'point', point: { x: 1, y: 1 } },
        },
      ],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.remove', id: 'a' }],
    })

    const stored = (await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)).canvas
    expect(stored?.lines?.map((line) => line.id)).toEqual(['free'])
  })
})

/**
 * `writeSpatialCanvas` resyncs by OMISSION, so every collection the batch
 * does not carry back is deleted. The canvas's facets and its untouched
 * comments were already carried for that reason; `lines` was not, so the
 * editor could draw ink (slice 3b) and the next tool call anywhere on the
 * board erased it.
 */
describe('wb_canvas_edit — ink the batch never mentions', () => {
  test('keeps a line a previous author drew, through an unrelated edit', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text: 'A' })],
      edges: [],
      lines: [
        {
          id: 'l1',
          from: { kind: 'point', point: { x: 0, y: 0 } },
          to: { kind: 'point', point: { x: 9, y: 9 } },
        },
      ],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.patch', id: 'a', patch: { text: 'edited' } }],
    })

    const stored = (await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)).canvas
    expect(stored?.lines?.map((line) => line.id)).toEqual(['l1'])
  })
})
