/**
 * A lock is a person's promise that an agent will not change an element, so
 * every op that can change one must refuse a locked target. One table over
 * the op vocabulary rather than a test per op: the ops are a closed union,
 * and an op added later is neither guarded nor exempt until someone says
 * which, so a new verb cannot ship as a way around a lock.
 */
import { writeDocumentKind, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { canvasEditInputSchema, createCanvasEditTool } from './canvas-edit.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

type Op = Parameters<ReturnType<typeof createCanvasEditTool>['execute']>[0]['ops'][number]

// `a` is a text node (so it can be spliced) and sits inside the group `g`,
// which is what lets `region.set` reach a locked member; `e` joins `a` and `b`.
const BOARD: SpatialCanvas = {
  nodes: [
    groupNode({ id: 'g', x: 0, y: 0, width: 500, height: 500, label: 'Phase' }),
    textNode({ id: 'a', x: 20, y: 20, width: 80, height: 40, text: 'A' }),
    textNode({ id: 'b', x: 700, y: 0, width: 80, height: 40, text: 'B' }),
  ],
  edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' } }],
}

const LOCK_NODE: Op = { op: 'node.lock', id: 'a', locked: true }
const LOCK_EDGE: Op = { op: 'edge.lock', id: 'e', locked: true }

interface Guarded {
  /** The lock the batch sets first, so the op under test is at index 1. */
  readonly lock: Op
  readonly op: Op
}

/** Every op that can change an element a lock covers, aimed at a locked one. */
const GUARDED: Record<string, Guarded> = {
  'node.patch': { lock: LOCK_NODE, op: { op: 'node.patch', id: 'a', patch: { x: 30 } } },
  'node.splice': {
    lock: LOCK_NODE,
    op: { op: 'node.splice', id: 'a', startLine: 0, endLine: 0, replacement: 'changed' },
  },
  'node.remove': { lock: LOCK_NODE, op: { op: 'node.remove', id: 'a' } },
  'edge.patch': { lock: LOCK_EDGE, op: { op: 'edge.patch', id: 'e', patch: { label: 'x' } } },
  'edge.remove': { lock: LOCK_EDGE, op: { op: 'edge.remove', id: 'e' } },
  // Deletes by omission: `a` is inside `g` and unlisted.
  'region.set': { lock: LOCK_NODE, op: { op: 'region.set', within: 'g', nodes: [] } },
}

/** The ops no lock can refuse, each with the reason, so the list cannot rot. */
const EXEMPT: Record<string, string> = {
  'node.add': 'creates an element, so there is nothing locked to change',
  'edge.add': 'creates an element, so there is nothing locked to change',
  'line.add': 'creates an element, and lines have no lock',
  'line.patch': 'lines have no lock',
  'line.remove': 'lines have no lock',
  'node.lock': 'unlocking is the one op a locked element still accepts',
  'edge.lock': 'unlocking is the one op a locked element still accepts',
  tidy: 'treats a locked node as a fixed obstacle and routes around it rather than refusing',
  'comment.add': 'the annotation layer floats above content and is not what a lock covers',
  'comment.resolve': 'the annotation layer floats above content and is not what a lock covers',
}

/** Every op the tool accepts, read from the schema the model is shown. */
function opNames(): string[] {
  return canvasEditInputSchema.shape.ops.element.options.map((option) => option.shape.op.value)
}

async function toolOverLockableBoard() {
  const store = new FakeDocumentStore()
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, BOARD)
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  return createCanvasEditTool(
    makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
  )
}

describe('wb_canvas_edit locks', () => {
  test('classifies every op as guarded or exempt, and no op as both', () => {
    const ops = opNames()
    // The subject is present: the vocabulary is far larger than this floor.
    expect(ops.length).toBeGreaterThan(15)
    expect(Object.keys(GUARDED).filter((name) => name in EXEMPT)).toEqual([])
    expect([...Object.keys(GUARDED), ...Object.keys(EXEMPT)].sort()).toEqual([...ops].sort())
  })

  test.each(Object.entries(GUARDED))('%s refuses a locked target', async (_name, guarded) => {
    const tool = await toolOverLockableBoard()
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [guarded.lock, guarded.op],
      }),
    ).rejects.toMatchObject({
      name: 'CanvasEditError',
      opIndex: 1,
      message: expect.stringMatching(/locked/),
    })
  })
})
