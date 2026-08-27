/**
 * `wb_document_delete` must capture what it is going to clean up while
 * holding the workspace write lock, the way the HTTP DELETE has always done.
 *
 * The HTTP path wraps its whole sequence in `withWorkspaceWriteLock`. The
 * agent path does not: only the index's row delete takes the lock, from
 * inside. That leaves the teardown's capture OUTSIDE it, so a version saved
 * by a concurrent writer after the capture has its row cascaded away by the
 * delete while its thumbnail was never in the captured set — the orphaned
 * file the teardown seam exists to prevent, on the one path the seam was
 * added for.
 *
 * Deterministic rather than racy: the writer holds the lock across the
 * whole window, so the interleaving is imposed instead of hoped for.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
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

const { withWorkspaceWriteLock } = await import('./workspace-lock.js')
const { FileVersionStore, thumbnailPath } = await import('./version-store.js')
const { getDb } = await import('./db/index.js')
const { prepareDataDir } = await import('./db/prepare.js')
const { createContainer, resolveServerDeps } = await import('../../di/container.js')
const { createStoreLocalModule } = await import('../../di/store-local.module.js')
const { wbDocumentCreate, wbDocumentDelete } = await import('@kamiazya/whiteboard-server-core')

describe('wb_document_delete', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-delete-lock-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('leaves no thumbnail behind for a version saved while the delete is in flight', async () => {
    await prepareDataDir(tempDir)
    const db = await getDb(tempDir)
    const deps = resolveServerDeps(
      createContainer(createStoreLocalModule({ db, blobDir: tempDir })),
    )
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doomed',
      kind: 'spatial',
      createWorkspace: true,
    })

    // The writer holds the lock in its own async chain, so the delete
    // started below cannot re-enter it — reentrancy is tracked per call
    // chain, and starting the delete inside this callback would legitimately
    // skip the queue rather than exposing what this test is about.
    let releaseWriter!: () => void
    const mayWrite = new Promise<void>((resolve) => {
      releaseWriter = resolve
    })
    let writerAcquired!: () => void
    const lockHeld = new Promise<void>((resolve) => {
      writerAcquired = resolve
    })
    const versions = new FileVersionStore()
    const writer = withWorkspaceWriteLock('ws-1', async () => {
      writerAcquired()
      await mayWrite
      const entry = await versions.save('ws-1', 'doomed', new LoroDoc(), { auto: false })
      await versions.saveThumbnail('ws-1', entry.id, new Uint8Array([1, 2, 3]))
      return entry.id
    })
    await lockHeld

    const deleted = wbDocumentDelete(deps, {
      workspaceId: 'ws-1',
      documentId: created.documentId,
    })
    // Let the delete run as far as it can before it needs the lock. What it
    // manages to do here is exactly the part this test is about.
    await new Promise((resolve) => setImmediate(resolve))

    releaseWriter()
    const versionId = await writer
    await deleted

    expect(existsSync(thumbnailPath('ws-1', versionId))).toBe(false)
  })
})
