// A document still holding the flat comments plane is refused by whichever
// read reaches its annotations, with the typed error `create-server` maps to
// 409 and a message that states how many comments the plane holds. The engine
// answers a refusal as a class name, so each tool that reads annotations
// through a document session is held to the adapter's own error here.
import {
  RetiredCommentPlaneError,
  writeDocumentKind,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore, placeUnlessPlaced, seedDoc } from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createCanvasRenderSvgTool } from './canvas-render-svg.js'
import { createCanvasViewTool } from './canvas-view.js'
import { createDocumentGetTool } from './document-get.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = '01ZVM89A4A1V9FS03Z9J64KEK1'
const ROWS = 3

async function deps() {
  const store = new FakeDocumentStore()
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, { nodes: [], edges: [] })
    for (let row = 1; row <= ROWS; row += 1) {
      doc.getMap('comments').set(`c${row}`, { id: `c${row}`, x: 1, y: 2, text: 'before threads' })
    }
    doc.commit()
  })
  await placeUnlessPlaced(store, WORKSPACE_ID, DOCUMENT_ID)
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    path: 'board',
    documentId: DOCUMENT_ID,
    kind: 'spatial',
  })
  return makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
}

const expected = new RetiredCommentPlaneError(ROWS)

async function refusalOf(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => undefined,
    (err: unknown) => err,
  )
}

describe('a document holding the retired comments plane', () => {
  test.each([
    [
      'wb_scene_render with comments',
      async () =>
        createCanvasRenderSvgTool(await deps()).execute({
          workspaceId: WORKSPACE_ID,
          documentId: DOCUMENT_ID,
          embedReferences: false,
          comments: true,
          style: 'clean',
        }),
    ],
    [
      'canvas_view',
      async () =>
        createCanvasViewTool(await deps()).execute({
          workspaceId: WORKSPACE_ID,
          documentId: DOCUMENT_ID,
        } as never),
    ],
    [
      'wb_document_get',
      async () =>
        createDocumentGetTool(await deps()).execute({
          workspaceId: WORKSPACE_ID,
          documentIds: [DOCUMENT_ID],
        } as never),
    ],
  ])('%s refuses with the typed error, its code and its count', async (_name, run) => {
    const refusal = await refusalOf(run)

    expect(refusal).toBeInstanceOf(RetiredCommentPlaneError)
    expect((refusal as RetiredCommentPlaneError).code).toBe(expected.code)
    expect((refusal as RetiredCommentPlaneError).message).toBe(expected.message)
    expect((refusal as RetiredCommentPlaneError).rows).toBe(ROWS)
  })
})
