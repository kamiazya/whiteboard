/**
 * The purge route's refusals, driven through the real store rather than a
 * mocked purge: a saved version whose stored frontiers will not check out is
 * a unit the scan could not judge (503, nothing deleted), a workspace record
 * that will not decode leaves no reference set at all (500), and a files
 * directory that resolves outside the data dir is never listed (500).
 */
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceDir, workspaceFilesDir } from '../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createFilesRouter } = await import('./files.js')
const { testFilesRouterOptions, testStoreScope } = await import('./_test-helpers.js')
const { saveDocument, _clearWorkspaceDocCacheForTests } = await import('../store/document-store.js')
const { FileVersionStore } = await import('../store/version-store.js')
const { LibsqlDocumentStore } = await import('../store/libsql/libsql-document-store.js')
const { createIsolatedDb } = await import('../store/db/test-helpers.js')
const { makeSpatialDocWithImage } = await import('../../shared/test-utils/spatial-doc.js')

const WORKSPACE = 'ws_purge_route'

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-purge-route-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
})

afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

/** An upload aged past the grace window, so only the reference set decides it. */
async function seedAgedFile(fileId: string): Promise<string> {
  const dir = workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, WORKSPACE)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${fileId}.png`)
  await writeFile(path, Buffer.from(`png:${fileId}`))
  const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000
  await utimes(path, past, past)
  return dir
}

function purge() {
  const app = createFilesRouter(testFilesRouterOptions(testStoreScope(tempDir)))
  return app.request(`/api/workspaces/${WORKSPACE}/files/purge-dangling`, { method: 'POST' })
}

describe('POST purge-dangling against the real store', () => {
  it('answers 503 and deletes nothing when a saved version is corrupt', async () => {
    await saveDocument(WORKSPACE, 'page', makeSpatialDocWithImage('only-then'))
    const saved = await new FileVersionStore().save(
      WORKSPACE,
      'page',
      makeSpatialDocWithImage('only-then'),
      { auto: false },
    )
    await saveDocument(WORKSPACE, 'page', makeSpatialDocWithImage('now'), { overwrite: true })
    await handle.db
      .updateTable('versions')
      .set({ frontiers: 'bm90LWZyb250aWVycw==' })
      .where('id', '=', saved.id)
      .execute()
    const dir = await seedAgedFile('only-then')
    await seedAgedFile('orphan')

    const res = await purge()

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({ error: 'incomplete_file_gc_scan' })
    expect((await readdir(dir)).sort()).toEqual(['only-then.png', 'orphan.png'])
  })

  it('answers 500 corrupt_stored_data when the workspace record will not decode', async () => {
    await saveDocument(WORKSPACE, 'page', makeSpatialDocWithImage('drawn'))
    const { manifest, chunks } = chunkSnapshot(Buffer.from('not-a-loro-snapshot'), 1_000_000)
    await new LibsqlDocumentStore(handle.db).saveSnapshot({
      docRef: { kind: 'workspace-tree', workspaceId: WORKSPACE },
      manifest,
      chunks,
      frontier: new Uint8Array(),
    })
    _clearWorkspaceDocCacheForTests()
    const dir = await seedAgedFile('drawn')

    const res = await purge()

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toMatchObject({ error: 'corrupt_stored_data' })
    expect(await readdir(dir)).toEqual(['drawn.png'])
  })

  it('answers 500 files_dir_not_contained and unlinks nothing through a symlinked files dir', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'whiteboard-purge-route-outside-'))
    try {
      await writeFile(join(outside, 'victim.png'), Buffer.alloc(10, 1))
      const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000
      await utimes(join(outside, 'victim.png'), past, past)
      const dir = workspaceDir(tempDir, SELF_HOST_TENANT_ID, WORKSPACE)
      await mkdir(dir, { recursive: true })
      await symlink(outside, join(dir, 'files'), 'dir')

      const res = await purge()

      expect(res.status).toBe(500)
      await expect(res.json()).resolves.toMatchObject({ error: 'files_dir_not_contained' })
      expect(await readdir(outside)).toEqual(['victim.png'])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
