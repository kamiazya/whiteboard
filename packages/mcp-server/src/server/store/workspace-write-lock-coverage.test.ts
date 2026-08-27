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
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

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
const { clearCache } = await import('./doc-cache.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ws-lock-coverage-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearCache()
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

function canvasDoc(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text }],
    edges: [],
  })
  return doc
}

function treeIndex() {
  return new CacheCoherentDocumentIndex(
    cacheBackedWorkspaceDocs(),
    new FsBlobStore(tempDir),
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
      index.setDocumentName({ workspaceId: WS, path: 'doc', name: 'renamed' }),
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
