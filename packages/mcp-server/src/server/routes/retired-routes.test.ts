// @vitest-environment node
/**
 * A route the daemon no longer serves answers an older client in the
 * contract's own voice: 404 `{ error: 'not_found', message }`, never a 500
 * and never a write that lands somewhere else.
 *
 * The hosted app and the daemon update independently, so a page built
 * against an earlier daemon keeps calling what it was built with. Driven
 * through `createApp`, since the answer for a path nothing registers is the
 * app's own fallback, not any router's.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiErrorBodySchema } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../../di/container.js'
import { createSelfHostStoreLocalModule } from '../../di/store-local.module.js'
import { createWorkspaceReplicaKeyStore } from '../security/workspace-replica-key-store.js'
import { createIsolatedDb, type IsolatedDbHandle } from '../store/db/test-helpers.js'
import { createTestDocument, testDataLayout } from './_test-helpers.js'

let dataDir = ''
vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createApp } = await import('../app.js')

const TOKEN = 'retired-routes-token'
const WS = 'ws-retired'

let handle: IsolatedDbHandle | undefined
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-retired-routes-'))
})
afterEach(async () => {
  await handle?.dispose()
  handle = undefined
  await rm(dataDir, { recursive: true, force: true })
})

async function app() {
  handle = await createIsolatedDb({ dataDir })
  const serverDeps = resolveServerDeps(
    createContainer(createSelfHostStoreLocalModule(handle.db, dataDir)),
  )
  await serverDeps.documentIndex.createWorkspace({ workspaceId: WS })
  await createTestDocument(serverDeps, { workspaceId: WS, path: 'board' })
  return {
    serverDeps,
    app: createApp({
      authMode: 'local-daemon',
      token: TOKEN,
      touch: () => {},
      getStatus: () => ({}) as never,
      serverDeps,
      dataLayout: testDataLayout(),
      replicaKeys: createWorkspaceReplicaKeyStore(handle.db, { defaultTier: 'offline' }),
    }),
  }
}

function loroUpdate(): Uint8Array<ArrayBuffer> {
  const doc = new LoroDoc()
  doc.getMap('retired').set('written', true)
  doc.commit()
  return doc.export({ mode: 'update' }) as Uint8Array<ArrayBuffer>
}

describe('a route the daemon retired', () => {
  it('POST …/document/<path>/update answers 404 in the error contract and writes nothing', async () => {
    const { app: served, serverDeps } = await app()
    const res = await served.request(`/api/w/${WS}/document/board/update`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/octet-stream',
      },
      body: loroUpdate(),
    })

    expect(res.status).toBe(404)
    const body: unknown = await res.json()
    expect(apiErrorBodySchema.parse(body)).toMatchObject({ error: 'not_found' })
    const stored = await serverDeps.liveDocuments.get(WS, 'board')
    expect(stored.getMap('retired').get('written')).toBeUndefined()
  })
})
