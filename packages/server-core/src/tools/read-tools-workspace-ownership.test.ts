/**
 * The read tools address a document by `documentId`, and the store loads by
 * that id alone — so without the ownership guard, a `workspaceId` that does
 * not place the document still reads it.
 */
import { writeDocumentKind, writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createCanvasRenderSvgTool } from './canvas-render-svg.js'
import { createCanvasSnapshotTool } from './canvas-snapshot.js'
import { createCanvasViewTool } from './canvas-view.js'
import { WorkspaceDocumentNotFoundError } from './document-crud.errors.js'
import { exportJsonCanvas } from './export-json-canvas.js'
import { exportOkf } from './export-okf.js'

const OWNER = 'ws-owner'
const STRANGER = 'ws-stranger'
const SPATIAL_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const MARKDOWN_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'

async function depsWithOwnedDocuments(): Promise<ServerDeps> {
  const documentStore = new FakeDocumentStore()
  await seedDoc(documentStore, SPATIAL_ID, (doc) => writeDocumentKind(doc, 'spatial'))
  await seedDoc(documentStore, MARKDOWN_ID, (doc) => {
    writeDocumentKind(doc, 'markdown')
    writeMarkdownBody(doc, '# owned')
  })
  await registerDocumentInWorkspace(documentStore, OWNER, SPATIAL_ID, 'board')
  documentStore.documentIndex.seed({
    workspaceId: OWNER,
    documentId: MARKDOWN_ID,
    path: 'notes',
    kind: 'markdown',
  })
  await documentStore.documentIndex.createWorkspace({ workspaceId: STRANGER })
  return makeTestDeps({ documentStore, documentIndex: documentStore.documentIndex })
}

type Read = (deps: ServerDeps, workspaceId: string) => Promise<unknown>

const READS: ReadonlyArray<readonly [string, Read]> = [
  [
    'wb_scene_render',
    (deps, workspaceId) =>
      createCanvasRenderSvgTool(deps).execute({
        workspaceId,
        documentId: SPATIAL_ID,
        embedReferences: false,
        comments: false,
        style: 'clean',
      }),
  ],
  [
    'canvas_view',
    (deps, workspaceId) =>
      createCanvasViewTool(deps).execute({ workspaceId, documentId: SPATIAL_ID }),
  ],
  [
    'wb_canvas_snapshot',
    (deps, workspaceId) =>
      createCanvasSnapshotTool(deps).execute({ workspaceId, documentId: SPATIAL_ID }),
  ],
  [
    'the JSON Canvas projection',
    (deps, workspaceId) => exportJsonCanvas(deps, { workspaceId, documentId: SPATIAL_ID }),
  ],
  [
    'the OKF projection',
    (deps, workspaceId) => exportOkf(deps, { workspaceId, documentId: MARKDOWN_ID }),
  ],
]

describe('a read tool given a workspace that does not place the document', () => {
  it.each(READS)('%s refuses it as not found', async (_name, read) => {
    const deps = await depsWithOwnedDocuments()

    await expect(read(deps, STRANGER)).rejects.toThrow(WorkspaceDocumentNotFoundError)
  })

  it.each(READS)('%s still reads it through the owning workspace', async (_name, read) => {
    const deps = await depsWithOwnedDocuments()

    await expect(read(deps, OWNER)).resolves.toBeDefined()
  })
})
