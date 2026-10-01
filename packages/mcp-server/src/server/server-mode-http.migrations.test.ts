/**
 * Server mode must hand its ports a MIGRATED database, as the local daemon
 * does (`http-server.migrations.test.ts`).
 *
 * `getDb` opens the file and nothing more, so a root that builds `ServerDeps`
 * from it on a data dir nothing has touched answers `no such table:
 * workspaces`; and one that never ensured the current workspace serves an
 * empty list. Server mode used to be migrated only because `ensureWorkspaceId`
 * runs `prepareDataDir` itself.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bearerNamesItsSubject, ISSUER, PUBLIC_URL } from './_test-server-mode-harness.js'
import { toServedServer } from './_test-server-mode-served.js'
import { createMemberProfileStore } from './security/member-profile-store.js'

let tempDir: string

vi.mock(
  '@hono/node-server',
  async () => (await import('./_test-server-mode-served.js')).nodeServerStub,
)

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js')
  return {
    ...actual,
    get DATA_DIR() {
      return tempDir
    },
    getDataDir: () => tempDir,
  }
})

const { startServerModeHttp } = await import('./server-mode-http.js')
const { getDb } = await import('./store/db/index.js')

let running: Awaited<ReturnType<typeof startServerModeHttp>> | undefined

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-migrations-'))
})
afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('startServerModeHttp on a data dir nothing has migrated', () => {
  it('serves /api/v1 rather than answering "no such table", and holds its current workspace', async () => {
    running = await startServerModeHttp({
      host: 'board.example',
      port: 443,
      publicBaseUrl: PUBLIC_URL,
      allowedOrigins: [PUBLIC_URL],
      authStrategy: bearerNamesItsSubject,
    })
    const db = await getDb(tempDir)
    expect((await db.selectFrom('workspaces').select('id').execute()).length).toBeGreaterThan(0)

    await createMemberProfileStore(db).ensureProfile({
      binding: { authenticator: ISSUER, subject: 'ada' },
      displayName: 'ada',
    })
    const headers = { Authorization: 'Bearer ada', 'content-type': 'application/json' }
    const created = await toServedServer(`${PUBLIC_URL}/api/workspaces`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ displayName: 'Plans' }),
    })
    expect(created.status).toBeLessThan(300)
    const { workspaceId } = (await created.json()) as { workspaceId: string }

    const res = await toServedServer(`${PUBLIC_URL}/api/v1/workspaces/${workspaceId}/documents`, {
      headers,
    })
    expect(res.status).toBe(200)
  })
})
