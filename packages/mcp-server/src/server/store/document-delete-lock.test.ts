/**
 * `wbDocumentDelete` must capture what it is going to clean up while
 * holding the workspace write lock, the way the HTTP DELETE has always done.
 *
 * The HTTP path wraps its whole sequence in `withWorkspaceWriteLock`. The
 * agent path does not: only the index's row delete takes the lock, from
 * inside. Without the teardown taking the lock around the WHOLE sequence, a
 * version saved by a concurrent writer could land beside a document that is
 * already gone — a row nothing can reach, since 0016 dropped the cascade
 * that used to collect it.
 *
 * A delete into the trash KEEPS the document's rows, because a restore
 * rejoins them; the purge is what removes them. So "no orphan" is asserted
 * at the point nothing can bring the document back: after the purge, or
 * after a delete that left no trash entry.
 *
 * Deterministic rather than racy: the writer holds the lock across the
 * whole window, so the interleaving is imposed instead of hoped for.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteWorkspaceNodeAtPath } from '@kamiazya/whiteboard-loro-adapter'
import { hasDocumentTrash } from '@kamiazya/whiteboard-ports'
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
const { createSelfHostStoreLocalModule } = await import('../../di/store-local.module.js')
const { wbDocumentCreate, wbDocumentDelete } = await import('@kamiazya/whiteboard-server-core')

describe('wbDocumentDelete', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-delete-lock-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('leaves no version row behind once the purge runs, for a version saved while the delete is in flight', async () => {
    await prepareDataDir(tempDir)
    const db = await getDb(tempDir)
    const deps = resolveServerDeps(createContainer(createSelfHostStoreLocalModule(db, tempDir)))
    // Registered explicitly: `createWorkspace: true` is ADR-0019's MINT
    // boundary, and a mint would key the workspace by a fresh ULID,
    // never by the id the store reads below address.
    await deps.documentIndex.createWorkspace({ workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1' })
    const created = await wbDocumentCreate(deps, {
      workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1',
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
    const writer = withWorkspaceWriteLock('01ZVM89A4A1V9FS03Z9J64KEK1', async () => {
      writerAcquired()
      await mayWrite
      const entry = await versions.save('01ZVM89A4A1V9FS03Z9J64KEK1', 'doomed', new LoroDoc(), {
        auto: false,
      })
      return entry.id
    })
    await lockHeld

    const deleted = wbDocumentDelete(deps, {
      workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1',
      documentId: created.documentId,
    })
    // Let the delete run as far as it can before it needs the lock. What it
    // manages to do here is exactly the part this test is about.
    await new Promise((resolve) => setImmediate(resolve))

    releaseWriter()
    const versionId = await writer
    await deleted

    const rowsOf = () =>
      db.selectFrom('versions').select(['documentId']).where('id', '=', versionId).execute()
    // Kept with the trashed document, keyed by the id a restore brings back.
    expect(await rowsOf()).toEqual([{ documentId: created.documentId }])
    if (!hasDocumentTrash(deps.documentIndex)) throw new Error('store-local index has a trash')
    await deps.documentIndex.purgeTrashEntry({
      workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1',
      documentId: created.documentId,
    })
    expect(await rowsOf()).toEqual([])
  })

  it('sweeps the version rows of a delete that left nothing in the trash to restore', async () => {
    await prepareDataDir(tempDir)
    const db = await getDb(tempDir)
    const deps = resolveServerDeps(createContainer(createSelfHostStoreLocalModule(db, tempDir)))
    await deps.documentIndex.createWorkspace({ workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1' })
    const created = await wbDocumentCreate(deps, {
      workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1',
      path: 'gone',
      kind: 'spatial',
    })
    await new FileVersionStore().save('01ZVM89A4A1V9FS03Z9J64KEK1', 'gone', new LoroDoc(), {
      auto: false,
    })

    // Removes the node the way no trash-recording delete does, so nothing
    // is left that a restore could rejoin the rows to.
    await deps.documentTeardown.around(
      { workspaceId: '01ZVM89A4A1V9FS03Z9J64KEK1', documentId: created.documentId, path: 'gone' },
      async () => {
        const record = await deps.workspaceDocuments.get('01ZVM89A4A1V9FS03Z9J64KEK1')
        expect(deleteWorkspaceNodeAtPath(record, 'gone')).toBe(true)
        await deps.workspaceDocuments.save('01ZVM89A4A1V9FS03Z9J64KEK1', record)
      },
    )

    const rows = await db
      .selectFrom('versions')
      .select(['id'])
      .where('documentId', '=', created.documentId)
      .execute()
    expect(rows).toEqual([])
  })
})
