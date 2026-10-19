/**
 * What checking a `wb_thread_edit` batch's anchors costs, COUNTED rather than
 * timed so the number is the same on any machine and under any load.
 *
 * The count is reads of a node's or an edge's `id` on the board the batch is
 * checked against. A batch may hold `OPS_PER_CALL_MAX` ops, each anchor may
 * name a board's worth of nodes, and the check runs under the workspace write
 * lock — so looking each named id up by walking the board is ops x ids x nodes
 * of work, repeatable at will because a refused batch stores nothing.
 */
import * as loroAdapter from '@kamiazya/whiteboard-loro-adapter'
import { writeDocumentKind, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test, vi } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createThreadEditTool } from './thread-edit.js'

const tally = { idReads: 0 }

function countingIds<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return items.map(
    (item) =>
      new Proxy(item, {
        get(target, key, receiver) {
          if (key === 'id') tally.idReads += 1
          return Reflect.get(target, key, receiver)
        },
      }),
  )
}

vi.mock('@kamiazya/whiteboard-loro-adapter', async (importOriginal) => {
  const real = await importOriginal<typeof loroAdapter>()
  return {
    ...real,
    readDocumentContent: (...args: Parameters<typeof real.readDocumentContent>) => {
      const content = real.readDocumentContent(...args)
      if (content.kind !== 'spatial') return content
      const { nodes, edges } = content.canvas
      return {
        ...content,
        canvas: { ...content.canvas, nodes: countingIds(nodes), edges: countingIds(edges) },
      }
    },
  }
})

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'
const BOARD_NODES = 2000
const IDS_PER_ANCHOR = 2000
const OPS = 20

function board(): SpatialCanvas {
  const nodes = Array.from({ length: BOARD_NODES }, (_, i) =>
    textNode({ id: `n${i}`, x: i * 10, y: 0, width: 100, height: 40, text: `n${i}` }),
  )
  const edges = Array.from({ length: BOARD_NODES - 1 }, (_, i) => ({
    id: `e${i}`,
    from: { node: `n${i}` },
    to: { node: `n${i + 1}` },
  }))
  return { nodes, edges }
}

describe('wb_thread_edit anchor check cost', () => {
  test('is linear in the ids the batch names plus the board, not their product', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, board())
    })
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    const tool = createThreadEditTool(
      makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    )
    // Named last-first, so a walk from the front of the board finds each one late.
    const named = Array.from({ length: IDS_PER_ANCHOR }, (_, i) => `n${BOARD_NODES - 1 - i}`)
    const ops = [
      ...Array.from({ length: OPS }, () => ({
        op: 'thread.add' as const,
        anchor: { kind: 'spatial' as const, nodeIds: named, x: 0, y: 0 },
        body: 'about all of these',
      })),
      {
        op: 'thread.add' as const,
        anchor: { kind: 'spatial' as const, edgeId: `e${BOARD_NODES - 2}`, x: 0, y: 0 },
        body: 'about this edge',
      },
      {
        op: 'thread.add' as const,
        anchor: { kind: 'spatial' as const, nodeIds: ['n0', 'missing'], x: 0, y: 0 },
        body: 'a typo',
      },
    ]

    tally.idReads = 0
    await expect(
      tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, ops }),
    ).rejects.toThrow(
      'ops[21] (thread.add) could not be applied: node "missing" is not on the canvas. Nothing was written.',
    )

    // The subject is present: the board reached the check through the seam.
    expect(tally.idReads).toBeGreaterThanOrEqual(BOARD_NODES)
    // Each board id read a few times to index it, nothing per named id. Walking
    // the board for each named id read these ids 40,023,112 times.
    expect(tally.idReads).toBeLessThanOrEqual(4 * (BOARD_NODES + BOARD_NODES - 1))
  })
})
