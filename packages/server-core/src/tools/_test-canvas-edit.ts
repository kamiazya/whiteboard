// Shared fixtures of the `canvas-edit*.test.ts` files: one seeded spatial
// document in one workspace, behind the fake document store.
import { writeDocumentKind, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { ServerDeps } from '../server-deps.js'
import {
  type FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'

export const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
export const WORKSPACE_ID = 'ws-1'

export function makeDeps(documentStore: FakeDocumentStore): ServerDeps {
  return makeTestDeps({
    documentStore: documentStore,
    documentIndex: documentStore.documentIndex,
  })
}

export async function seedCanvas(store: FakeDocumentStore, canvas: SpatialCanvas): Promise<void> {
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, canvas)
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
}

export const EMPTY: SpatialCanvas = { nodes: [], edges: [] }
