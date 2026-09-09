/**
 * `wbDocumentDelete` must capture what it is going to clean up while
 * holding the workspace write lock, the way the HTTP DELETE has always done.
 *
 * The HTTP path wraps its whole sequence in `withWorkspaceWriteLock`. The
 * agent path does not: only the index's row delete takes the lock, from
 * inside. Without the teardown taking the lock around the WHOLE sequence, a
 * version saved by a concurrent writer lands after the sweep and outlives
 * the document it belongs to — a row nothing can reach, since 0016 dropped
 * the cascade that used to collect it.
 *
 * Deterministic rather than racy: the writer holds the lock across the
 * whole window, so the interleaving is imposed instead of hoped for.
 */
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
const { FileVersionStore } = await import('./version-store.js')
const { getDb } = await import('./db/index.js')
const { prepareDataDir } = await import('./db/prepare.js')
const { createContainer, resolveServerDeps } = await import('../../di/container.js')
const { createStoreLocalModule } = await import('../../di/store-local.module.js')
const { wbDocumentCreate, wbDocumentDelete } = await import('@kamiazya/whiteboard-server-core')

describe('wbDocumentDelete', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-delete-lock-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('leaves no version row behind for a version saved while the delete is in flight', async () => {
    await prepareDataDir(tempDir)
    const db = await getDb(tempDir)
    const deps = resolveServerDeps(
      createContainer(createStoreLocalModule({ db, blobDir: tempDir })),
    )
    // Registered explicitly: `createWorkspace: true` is ADR-0019's MINT
    // boundary, and a mint would key the workspace by a fresh ULID with
    // `ws-1` as its segment — leaving the store reads below naming nothing.
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'doomed',
      kind: 'spatial',
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

    const survivors = await db
      .selectFrom('versions')
      .select(['id'])
      .where('id', '=', versionId)
      .execute()
    expect(survivors).toEqual([])
  })
})
