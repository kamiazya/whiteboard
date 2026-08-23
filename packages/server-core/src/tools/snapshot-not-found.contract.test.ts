// One condition, one error class.
//
// "This document has no saved snapshot" is a single condition — the store's
// `loadSnapshot` answering null — reached from both the read side (export,
// render, digest) and the write side (node/edge/body patches). It used to
// raise two different classes depending on which loader you happened to call,
// and `create-server.ts` had to name both in one `if` to give them the same
// 404. Nothing tied them together, so a third loader would have quietly grown
// a third class.
//
// The assertion compares the two CONSTRUCTORS rather than matching each
// against an imported class: `rejects.toThrow(X)` where `X` is an undefined
// import passes for any throw at all, so a test written that way would go
// green the moment the class moved. Comparing what the two sides actually
// raise cannot pass vacuously.
import { describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
} from '../test-utils/fake-document-store.js'
import { unusedDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { createCanvasEditTool } from './canvas-edit.js'
import { exportJsonCanvas } from './export-json-canvas.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

/**
 * A document the workspace index KNOWS about but whose snapshot was never
 * written. Registering it matters: the write side asserts workspace
 * membership before it loads, so an unregistered document fails that check
 * first and never reaches the condition under test.
 */
async function depsWithNoSnapshot() {
  const documentStore = new FakeDocumentStore()
  await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, DOCUMENT_ID)
  return {
    documentStore,
    blobStore: {} as never,
    documentIndex: documentStore.documentIndex,
    documentTeardown: unusedDocumentTeardown(),
  }
}

/** The error `run` raises, or a failure if it resolves. */
async function raisedBy(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run()
  } catch (err) {
    return err as Error
  }
  throw new Error('expected the call to reject for a document with no snapshot')
}

describe('a document with no saved snapshot', () => {
  test('the read and write sides raise ONE class, not a parallel pair', async () => {
    const readDeps = await depsWithNoSnapshot()
    const writeDeps = await depsWithNoSnapshot()
    const readSide = await raisedBy(() =>
      exportJsonCanvas(readDeps, {
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
      }),
    )
    const writeSide = await raisedBy(() =>
      // The write side is whichever tool mutates a canvas; `wb_node_add`
      // was that tool until the seven were retired into `wb_canvas_edit`.
      // What is under test is the loader they share, not the tool.
      createCanvasEditTool(writeDeps).execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        ops: [
          {
            op: 'node.add',
            node: { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' },
          },
        ],
      }),
    )

    expect(writeSide.constructor).toBe(readSide.constructor)
    expect(readSide.name).toBe('SnapshotNotFoundError')
  })
})
