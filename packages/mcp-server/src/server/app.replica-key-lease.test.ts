/**
 * How long the local daemon's offline lease runs when the composition names no
 * lifetime. `index.ts` always passes the operator's setting, so the router's
 * own fallback is the one thing that decides it for any other composition.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replicaKeyResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../di/container.js'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import { createApp } from './app.js'
import { testDataLayout } from './routes/_test-helpers.js'
import { createWorkspaceReplicaKeyStore } from './security/workspace-replica-key-store.js'
import { createIsolatedDb, type IsolatedDbHandle } from './store/db/test-helpers.js'

const TOKEN = 'lease-test-token'
const WORKSPACE = 'ws-lease'
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

let dir: string
let handle: IsolatedDbHandle

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wb-replica-lease-'))
  handle = await createIsolatedDb({ dataDir: dir })
})
afterEach(async () => {
  vi.useRealTimers()
  await handle.dispose()
  rmSync(dir, { recursive: true, force: true })
})

it('leases a bounded workspace key for seven days when the composition names no lifetime', async () => {
  const now = new Date('2030-01-01T00:00:00.000Z')
  vi.useFakeTimers({ toFake: ['Date'], now })
  const serverDeps = resolveServerDeps(createContainer(storeMemoryModule))
  const app = createApp({
    authMode: 'local-daemon',
    token: TOKEN,
    touch: () => {},
    getStatus: () => ({}) as never,
    serverDeps: {
      ...serverDeps,
      workspaceDocuments: { ...serverDeps.workspaceDocuments, exists: async () => true },
    },
    dataLayout: testDataLayout(),
    replicaKeys: createWorkspaceReplicaKeyStore(handle.db, { defaultTier: 'bounded' }),
  })

  const res = await app.request(`/api/workspaces/${WORKSPACE}/replica-key`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
  })

  expect(res.status).toBe(200)
  const body = replicaKeyResponseSchema.parse(await res.json())
  expect(body.tier).toBe('bounded')
  expect(body.leaseExpiresAt).toBe(new Date(now.getTime() + SEVEN_DAYS_MS).toISOString())
})
