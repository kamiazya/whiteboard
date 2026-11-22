import { leaseOps } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { vi } from 'vitest'
import { globalStoreScope, type StoreScope } from './store-scope.js'
import {
  _heldWorkspaceRecordForTests,
  withStoredWorkspaceRecord,
  withWorkspaceRecord,
} from './workspace-doc-cache.js'

/**
 * A copy of a workspace's stored record as a `LoroDoc`, minted empty inside a
 * registered workspace like the record a keeper serves. For a test that reads
 * what the record holds with the adapter's own readers; the copy is its own and
 * a write to it reaches nothing.
 */
export async function workspaceRecordCopy(
  workspaceId: string,
  scope: StoreScope = globalStoreScope,
): Promise<LoroDoc> {
  return withWorkspaceRecord(workspaceId, scope, async (session) =>
    LoroDoc.fromSnapshot(session.exportSnapshot()),
  )
}

/**
 * Edits a workspace's record the way a writer outside the daemon's operations
 * would: `change` mutates a `LoroDoc` copy, and what it added is imported into
 * the held record and saved, announced as every save is. `save: false` leaves
 * the held record ahead of what is stored, as a writer inside the workspace
 * barrier is between its edit and its save.
 */
export async function editWorkspaceRecord(
  workspaceId: string,
  change: (copy: LoroDoc) => void | Promise<void>,
  scope: StoreScope = globalStoreScope,
  { save = true }: { save?: boolean } = {},
): Promise<void> {
  await withWorkspaceRecord(workspaceId, scope, async (session) => {
    const copy = LoroDoc.fromSnapshot(session.exportSnapshot())
    const before = copy.version()
    await change(copy)
    copy.commit()
    session.importJudged(copy.export({ mode: 'update', from: before }), 'none')
    if (save) await session.save()
  })
}

/** `workspaceRecordCopy`, except that a workspace with nothing stored answers `null` rather than minting a record. */
export async function storedWorkspaceRecordCopy(
  workspaceId: string,
  scope: StoreScope = globalStoreScope,
): Promise<LoroDoc | null> {
  return withStoredWorkspaceRecord(workspaceId, scope, async (session) =>
    session === null ? null : LoroDoc.fromSnapshot(session.exportSnapshot()),
  )
}

/** Merges a whole `LoroDoc` into the workspace's record and saves it: a record some other writer built, arriving as a sync write does. */
export async function importWorkspaceRecord(
  workspaceId: string,
  doc: LoroDoc,
  scope: StoreScope = globalStoreScope,
): Promise<void> {
  await withWorkspaceRecord(workspaceId, scope, async (session) => {
    session.importJudged(doc.export({ mode: 'snapshot' }), 'none')
    await session.save()
  })
}

/**
 * Makes every write to the workspace's held record throw `error`, as a record
 * whose engine trapped keeps doing (`once` limits it to the first write). A
 * record the cache opens afterwards is not affected. Answers the held record,
 * so a test can tell it from the one that replaces it.
 */
export async function failWritesToWorkspaceRecord(
  workspaceId: string,
  error: Error,
  { once = false, scope = globalStoreScope }: { once?: boolean; scope?: StoreScope } = {},
): Promise<{ held: object; restore(): void }> {
  await workspaceRecordCopy(workspaceId, scope)
  const held = _heldWorkspaceRecordForTests(workspaceId, scope)
  if (held === undefined) throw new Error(`no record is held for ${workspaceId}`)
  const write = leaseOps.write
  const importJudged = leaseOps.importJudged
  let thrown = false
  const fails = (record: unknown) => {
    if (record !== held || (once && thrown)) return false
    thrown = true
    return true
  }
  const writeSpy = vi.spyOn(leaseOps, 'write').mockImplementation((record, batch) => {
    if (fails(record)) throw error
    return write(record, batch)
  })
  const importSpy = vi
    .spyOn(leaseOps, 'importJudged')
    .mockImplementation((record, bytes, judge) => {
      if (fails(record)) throw error
      return importJudged(record, bytes, judge)
    })
  return {
    held,
    restore() {
      writeSpy.mockRestore()
      importSpy.mockRestore()
    },
  }
}
