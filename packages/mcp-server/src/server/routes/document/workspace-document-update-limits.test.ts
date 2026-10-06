/**
 * A container name past `CONTAINER_NAME_MAX_CHARS` on the workspace-document
 * sync route, over the real router and a real store.
 *
 * Loro keeps such an update and then cannot read the snapshot it is saved
 * into, so the cost of letting one through is not one document but the whole
 * workspace, from the next load on — which is why every case reads the record
 * back from storage, with the caches dropped, rather than trusting the
 * process that answered.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncWriteRefusalOf } from '@kamiazya/whiteboard-daemon-client/api-contracts/sync-write-refusal'
import {
  documentContainers,
  readSpatialCanvas,
  resolveWorkspaceDocument,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestDocument,
  resolveTestServerDeps,
  seedWorkspaceRow,
  testDocumentRouterOptions,
} from '../_test-helpers.js'

let tempDir: string
let serverDeps: ServerDeps
vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createDocumentRouter } = await import('../document.js')
const { loadDocument, _clearWorkspaceDocCacheForTests } = await import(
  '../../store/document-store.js'
)
const { clearDocCacheForTests } = await import('../../store/doc-cache.js')
const { createIsolatedDb } = await import('../../store/db/test-helpers.js')

const WS = 'session1'
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ws-doc-update-limits-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
  await seedWorkspaceRow(tempDir, WS)
  serverDeps = await resolveTestServerDeps(tempDir)
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

/** A board at `c` holding one node, and a peer's replica of the record it sits in. */
async function setup() {
  const app = createDocumentRouter(
    testDocumentRouterOptions({ serverDeps, autoVersionQuietMs: 60_000 }),
  )
  await createTestDocument(serverDeps, { workspaceId: WS, path: 'c' })
  const seed = new LoroDoc()
  writeSpatialCanvas(seed, {
    nodes: [textNode({ id: 'n-a', text: 'a', x: 0, y: 0, width: 10, height: 10 })],
    edges: [],
  })
  const seeded = await app.request(`/api/w/${WS}/document/c/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(seed.export({ mode: 'update' })),
  })
  expect(seeded.status).toBe(200)
  const res = await app.request(`/api/w/${WS}/workspace-document/snapshot`)
  expect(res.status).toBe(200)
  const peer = LoroDoc.fromSnapshot(new Uint8Array(await res.arrayBuffer()))
  const documentId = resolveWorkspaceDocument(peer, 'c')?.documentId
  if (documentId === undefined) throw new Error('the seeded board is not in the record')
  const post = (edit: (doc: LoroDoc) => void) => {
    const from = peer.version()
    edit(peer)
    peer.commit()
    return app.request(`/api/w/${WS}/workspace-document/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(peer.export({ mode: 'update', from })),
    })
  }
  return { app, documentId, post }
}

/** What a restarted daemon finds: the board read from storage with every cache dropped. */
async function nodesAfterRestart(): Promise<string[]> {
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
  const doc = await loadDocument(WS, 'c')
  return readSpatialCanvas(doc).nodes.map((node) => node.id)
}

describe('a workspace-document update naming a container past its bound', () => {
  it.each([
    ['a root container', (doc: LoroDoc) => doc.getMap('r'.repeat(70_000)).set('a', 1)],
    [
      "a thread key under a board's thread plane",
      (doc: LoroDoc, documentId: string) =>
        documentContainers(doc, documentId)
          .getMap('threads')
          .ensureMergeableMap('t'.repeat(70_000))
          .set('status', 'open'),
    ],
  ])('answers 413 for %s and the record still opens', async (_, edit) => {
    const { app, documentId, post } = await setup()

    const refused = await post((doc) => edit(doc, documentId))

    expect(refused.status).toBe(413)
    expect(syncWriteRefusalOf(await refused.json()).code).toBe('container_name_too_long')
    expect(await nodesAfterRestart()).toEqual(['n-a'])
    const snapshot = await app.request(`/api/w/${WS}/workspace-document/snapshot`)
    expect(snapshot.status).toBe(200)
  })

  it('takes a thread whose name is within the bound', async () => {
    const { documentId, post } = await setup()

    const taken = await post((doc) =>
      documentContainers(doc, documentId)
        .getMap('threads')
        .ensureMergeableMap('short-thread')
        .set('status', 'open'),
    )

    expect(taken.status).toBe(200)
    expect(await nodesAfterRestart()).toEqual(['n-a'])
  })
})
