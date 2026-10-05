/**
 * Every writer of the live workspace record holds `withWorkspaceWriteLock`.
 *
 * The tree index has its own per-instance serialiser (`#serialise`) and the
 * store has the module-level workspace lock; they are DISJOINT mutexes over
 * the same mutable resource, so a writer holding only the former can
 * interleave with a locked `saveDocument`/`saveSnapshot` between its
 * `readFrontier` and `appendDeltas` — the lost-update shape
 * `workspace-lock.ts`'s own doc comment names. These tests pin the coverage
 * mechanically: while the lock is HELD, none of the writers below may
 * complete. Deterministic in the green direction — a writer inside the lock
 * cannot finish while the gate is closed, whatever the machine's timing.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { blobsRoot } from '../tenant/data-layout.js'
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

const { saveDocument, CacheCoherentDocumentIndex, cacheBackedWorkspaceDocs, workspaceRegistry } =
  await import('./document-store.js')
const { withWorkspaceWriteLock } = await import('./workspace-lock.js')
const { setDocumentDisplayName, setDocumentPinned } = await import('./names-store.js')
const { FsBlobStore } = await import('./fs/fs-blob-store.js')
const { clearDocCacheForTests } = await import('./doc-cache.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

// The lock is taken before the id is looked at, so any well-formed id reaches it.
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ws-lock-coverage-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearDocCacheForTests()
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

function canvasDoc(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 80, height: 40, text })],
    edges: [],
  })
  return doc
}

function treeIndex() {
  return new CacheCoherentDocumentIndex(
    cacheBackedWorkspaceDocs(),
    new FsBlobStore(blobsRoot(tempDir, SELF_HOST_TENANT_ID), tempDir),
    workspaceRegistry(),
  )
}

/**
 * 'blocked' when `op` could not complete while the workspace lock was held —
 * the passing answer. 150ms is generous for the failing (unlocked) direction
 * only; the passing direction does not depend on timing at all.
 */
async function raceAgainstHeldLock(
  workspaceId: string,
  op: () => Promise<unknown>,
): Promise<'blocked' | 'completed'> {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let acquired!: () => void
  const acquiredGate = new Promise<void>((resolve) => {
    acquired = resolve
  })
  const held = withWorkspaceWriteLock(workspaceId, async () => {
    acquired()
    await gate
  })
  await acquiredGate
  const started = op()
  const winner = await Promise.race([
    started.then(
      () => 'completed' as const,
      () => 'completed' as const,
    ),
    new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 150)),
  ])
  release()
  await held
  await started.catch(() => undefined)
  return winner
}

it('index.setDocumentName waits for the workspace write lock', async () => {
  const WS = 'ws-lock-name'
  await saveDocument(WS, 'doc', canvasDoc('content'), { kind: 'spatial' })
  const index = treeIndex()
  await expect(
    raceAgainstHeldLock(WS, () =>
      index.setDocumentName({ workspaceId: WS, documentId: DOCUMENT_ID, name: 'renamed' }),
    ),
  ).resolves.toBe('blocked')
})

it('index.createDocument waits for the workspace write lock', async () => {
  const WS = 'ws-lock-create'
  await saveDocument(WS, 'doc', canvasDoc('content'), { kind: 'spatial' })
  const index = treeIndex()
  await expect(
    raceAgainstHeldLock(WS, () =>
      index.createDocument({ workspaceId: WS, path: 'second', kind: 'spatial' }),
    ),
  ).resolves.toBe('blocked')
})

it('index.createWorkspace waits for the workspace write lock', async () => {
  const WS = 'ws-lock-create-ws'
  const index = treeIndex()
  await expect(
    raceAgainstHeldLock(WS, () => index.createWorkspace({ workspaceId: WS })),
  ).resolves.toBe('blocked')
})

it('names-store setDocumentDisplayName waits for the workspace write lock', async () => {
  const WS = 'ws-lock-display'
  await saveDocument(WS, 'doc', canvasDoc('content'), { kind: 'spatial' })
  await expect(
    raceAgainstHeldLock(WS, () => setDocumentDisplayName(WS, 'doc', 'Display')),
  ).resolves.toBe('blocked')
})

it('names-store setDocumentPinned waits for the workspace write lock', async () => {
  const WS = 'ws-lock-pin'
  await saveDocument(WS, 'doc', canvasDoc('content'), { kind: 'spatial' })
  await expect(raceAgainstHeldLock(WS, () => setDocumentPinned(WS, 'doc', true))).resolves.toBe(
    'blocked',
  )
})

// The writers are read off the class rather than listed here: an override
// added to the tree index is a writer of the same record, and one written
// without the lock is the lost update the header describes. A method named in
// neither table fails below, so the next one is classified when it is added.
type TreeIndex = InstanceType<typeof CacheCoherentDocumentIndex>

const WRITER_CASES: Record<string, (index: TreeIndex, workspaceId: string) => Promise<unknown>> = {
  createWorkspace: (index, workspaceId) => index.createWorkspace({ workspaceId }),
  renameWorkspace: (index, workspaceId) =>
    index.renameWorkspace({ workspaceId, displayName: 'Renamed' }),
  createDocument: (index, workspaceId) =>
    index.createDocument({ workspaceId, path: 'second', kind: 'spatial' }),
  setDocumentName: (index, workspaceId) =>
    index.setDocumentName({ workspaceId, documentId: DOCUMENT_ID, name: 'renamed' }),
  setDocumentPinned: (index, workspaceId) =>
    index.setDocumentPinned({ workspaceId, documentId: DOCUMENT_ID, pinned: true }),
  restoreDocument: (index, workspaceId) =>
    index.restoreDocument({ workspaceId, documentId: 'not-in-the-trash' }),
  purgeTrashEntry: (index, workspaceId) =>
    index.purgeTrashEntry({ workspaceId, documentId: 'not-in-the-trash' }),
  moveDocument: (index, workspaceId) =>
    index.moveDocument({ workspaceId, from: 'doc', to: 'moved' }),
  deleteDocument: (index, workspaceId) => index.deleteDocument({ workspaceId, path: 'doc' }),
  duplicateDocument: (index, workspaceId) => index.duplicateDocument({ workspaceId, path: 'doc' }),
}

/** Methods of the class that do not write the record, each with the reason. */
const NOT_WRITERS: Record<string, string> = {}

function ownMethods(): string[] {
  return Object.getOwnPropertyNames(CacheCoherentDocumentIndex.prototype).filter(
    (name) => name !== 'constructor',
  )
}

describe('every override of the tree index holds the workspace write lock', () => {
  it('classifies every method the class defines as a writer or a non-writer', () => {
    const methods = ownMethods()
    // The subject is present: the class overrides ten writers today.
    expect(methods.length).toBeGreaterThanOrEqual(10)
    expect(Object.keys(WRITER_CASES).filter((name) => name in NOT_WRITERS)).toEqual([])
    expect([...Object.keys(WRITER_CASES), ...Object.keys(NOT_WRITERS)].sort()).toEqual(
      [...methods].sort(),
    )
  })

  it.each(Object.entries(WRITER_CASES))('index.%s waits for the lock', async (name, write) => {
    const WS = `ws-lock-each-${name}`
    await saveDocument(WS, 'doc', canvasDoc('content'), { kind: 'spatial' })
    const index = treeIndex()
    await expect(raceAgainstHeldLock(WS, () => write(index, WS))).resolves.toBe('blocked')
  })
})
