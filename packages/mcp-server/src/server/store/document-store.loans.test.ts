/**
 * The writers hold the workspace record on loan for as long as they work on
 * it: a save, a move, a delete and a duplicate each take their loan before they
 * read the record and give it back when they are done, so the cache cannot hand
 * the record's memory back under them, and no loan is left out afterwards.
 *
 * The loan is watched from inside the operation, through the funnel every
 * persisted workspace update goes out by: it fires while the writer still holds
 * what it wrote.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceIdFor } from '@kamiazya/whiteboard-model/test-utils'
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

const {
  saveDocument,
  renameDocumentPath,
  deleteDocument,
  workspaceTreeIndex,
  onWorkspaceDocUpdated,
  resolveDocumentIdAtPath,
  _clearWorkspaceDocCacheForTests,
} = await import('./document-store.js')
const { _watchWorkspaceRecordLoansForTests } = await import('./workspace-doc-cache.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { globalStoreScope } = await import('./store-scope.js')

const WS = workspaceIdFor('loans')
let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'doc-store-loans-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  _clearWorkspaceDocCacheForTests()
})
afterEach(async () => {
  _clearWorkspaceDocCacheForTests()
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

/**
 * The loans the operation itself holds each time a persisted workspace update
 * goes out while `work` runs, and what it still holds when it is done: counted
 * by the records it took them of, not by what the process has out.
 */
async function loansDuring(
  work: () => Promise<unknown>,
): Promise<{ seen: number[]; left: () => number; taken: () => number }> {
  const watch = _watchWorkspaceRecordLoansForTests()
  const seen: number[] = []
  const stop = onWorkspaceDocUpdated(() => seen.push(watch.total()))
  try {
    await work()
  } finally {
    stop()
  }
  return { seen, left: watch.total, taken: watch.taken }
}

describe('a writer of the workspace record', () => {
  it('holds a loan while it saves a document, and none after', async () => {
    const { seen, left, taken } = await loansDuring(() =>
      saveDocument(WS, 'a', new LoroDoc(), { kind: 'markdown' }),
    )

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((loans) => loans >= 1)).toBe(true)
    expect(taken()).toBeGreaterThan(0)
    expect(left()).toBe(0)
  })

  it('holds a loan while it moves a document, and none after', async () => {
    await saveDocument(WS, 'a', new LoroDoc(), { kind: 'markdown' })

    const { seen, left, taken } = await loansDuring(() => renameDocumentPath(WS, 'a', 'b'))

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((loans) => loans >= 1)).toBe(true)
    expect(await resolveDocumentIdAtPath(WS, 'b')).not.toBeNull()
    expect(taken()).toBeGreaterThan(0)
    expect(left()).toBe(0)
  })

  it('holds a loan while it deletes a document, and none after', async () => {
    await saveDocument(WS, 'a', new LoroDoc(), { kind: 'markdown' })

    const { seen, left, taken } = await loansDuring(() => deleteDocument(WS, 'a'))

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((loans) => loans >= 1)).toBe(true)
    expect(taken()).toBeGreaterThan(0)
    expect(left()).toBe(0)
  })

  it('holds a loan while the index duplicates a document, and none after', async () => {
    await saveDocument(WS, 'a', new LoroDoc(), { kind: 'markdown' })
    const index = await workspaceTreeIndex(globalStoreScope)

    const { seen, left, taken } = await loansDuring(() =>
      index.duplicateDocument({ workspaceId: WS, path: 'a' }),
    )

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((loans) => loans >= 1)).toBe(true)
    expect(taken()).toBeGreaterThan(0)
    expect(left()).toBe(0)
  })

  it('gives its loan back when the write fails', async () => {
    await saveDocument(WS, 'a', new LoroDoc(), { kind: 'markdown' })

    const watch = _watchWorkspaceRecordLoansForTests()

    await expect(saveDocument(WS, 'a', new LoroDoc())).rejects.toThrow(/already exists/)

    expect(watch.taken()).toBeGreaterThan(0)
    expect(watch.total()).toBe(0)
  })
})
