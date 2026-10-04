/**
 * A database that is merely BUSY while the workspace record opens is not
 * corrupt stored data, and must not be told to a caller as if it were.
 *
 * `DatabaseBusyError` (the retry budget spent) and a raw libsql busy both
 * carry `code: 'SQLITE_BUSY'`; the answer a caller can act on is "try again",
 * where "corrupt" sends an operator looking for damage that is not there.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string
vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { getWorkspaceDoc, openWorkspaceDocIfStored, _clearWorkspaceDocCacheForTests } = await import(
  './workspace-doc-cache.js'
)
const { isCorruptStoredDataError } = await import('./corrupt-stored-data.js')
const { clearDocCacheForTests } = await import('./doc-cache.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
const WS = 'ws-busy'

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ws-doc-busy-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

describe('opening the workspace record while the database is busy', () => {
  it.each([
    ['SQLITE_BUSY', { code: 'SQLITE_BUSY' }],
    ['an extended busy code', { code: 'SQLITE_ERROR', extendedCode: 'SQLITE_BUSY_SNAPSHOT' }],
  ])('rethrows %s as itself, not as corrupt stored data', async (_name, codes) => {
    const err = Object.assign(new Error('database is locked'), codes)
    vi.spyOn(DocumentStoreWorkspaceDocs.prototype, 'open').mockRejectedValue(err)
    vi.spyOn(DocumentStoreWorkspaceDocs.prototype, 'create').mockRejectedValue(err)

    const read = await openWorkspaceDocIfStored(WS).catch((e: unknown) => e)
    const write = await getWorkspaceDoc(WS).catch((e: unknown) => e)

    expect(read).toBe(err)
    expect(write).toBe(err)
    expect(isCorruptStoredDataError(read)).toBe(false)
    expect(isCorruptStoredDataError(write)).toBe(false)
  })

  it('still reports a record that will not decode as corrupt stored data', async () => {
    vi.spyOn(DocumentStoreWorkspaceDocs.prototype, 'open').mockRejectedValue(
      new Error('wasm decode failed'),
    )

    const err = await openWorkspaceDocIfStored(WS).catch((e: unknown) => e)

    expect(isCorruptStoredDataError(err)).toBe(true)
  })
})
