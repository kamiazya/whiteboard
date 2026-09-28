/**
 * The daemon must hand its ports a MIGRATED database.
 *
 * `http-server.ts` builds `ServerDeps` from `getDb(dataDir)`, which opens the
 * file and nothing more. Migrations have only ever run through
 * `document-store.ts`'s `dbReady` — `prepareDataDir` then `getDb` — so on a
 * data dir nothing has touched yet, every surface that reaches the injected
 * ports instead of the legacy store answered `no such table: workspaces`.
 *
 * That was live for `/api/v1` from the day it was mounted, and reproduced by
 * hand against the packaged daemon before this test existed: a fresh
 * `daemon run` plus `GET /api/v1/workspaces/default/documents` returned 500.
 * Nothing caught it, because every other test and every real session had
 * already migrated the dir through some legacy call first.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { socketFetch, testSocketPath } from '../shared/test-utils/socket-fetch.js'

let tempDir: string

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

const { startHttpServer } = await import('./http-server.js')

describe('startHttpServer on a data dir nothing has migrated', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-http-migrations-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('serves /api/v1 rather than answering "no such table"', async () => {
    const socketPath = testSocketPath()
    const running = await startHttpServer({ socketPath })
    try {
      const res = await socketFetch(socketPath)('/api/v1/workspaces/default/documents')
      // Any answer the surface itself chose is fine — what must not happen is
      // the 500 an unmigrated schema produces.
      expect(res.status).not.toBe(500)
    } finally {
      await running.close()
    }
  })
})
