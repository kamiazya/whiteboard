import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isWorkspaceSegmentTakenError, WorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Swap DATA_DIR to a temp directory through vi.mock.
let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

// Use dynamic import so it runs after the mock is resolved.
const { saveDocument, listWorkspaces } = await import('./document-store.js')
const { getDefaultServerDeps } = await import('../../di/default-server-deps.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

async function setupIsolatedDb(): Promise<void> {
  handle = await createIsolatedDb({ dataDir: tempDir })
}

async function teardownIsolatedDb(): Promise<void> {
  await handle.dispose()
}

// Split from document-store.test.ts by topic (workspace registry surface);
// the vi.mock + awaited-import harness is per-file by necessity.

describe('listWorkspaces', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-test-'))
    await setupIsolatedDb()
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('lists workspaces seeded via saveDocument', async () => {
    await saveDocument('session-active', 'a', new LoroDoc())
    await saveDocument('session-old', 'a', new LoroDoc())

    const workspaces = await listWorkspaces()
    const ids = workspaces.map((s) => s.workspaceId)
    expect(ids).toContain('session-active')
    expect(ids).toContain('session-old')
  })

  it('returns an empty array when no workspaces have been saved yet', async () => {
    const workspaces = await listWorkspaces()
    expect(workspaces).toHaveLength(0)
  })

  // listWorkspaces is now backed by the workspaces table, so the previous
  // "non-directory DATA_DIR" corruption check no longer applies.
})

// ADR-0019: the daemon's own DocumentIndex (CacheCoherentDocumentIndex) is
// the first implementation that PERSISTS and SERVES segment/displayName —
// the shared ports conformance suite deliberately stays accept-and-ignore,
// so this echo/validation/conflict/non-clobber coverage lives here.
describe('createWorkspace — ADR-0019 identity (segment/displayName)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-ws-identity-test-'))
    await setupIsolatedDb()
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('echoes stored segment and displayName back through listWorkspaces', async () => {
    const deps = await getDefaultServerDeps()
    await deps.documentIndex.createWorkspace({
      workspaceId: 'ws-echo',
      segment: 'team-notes',
      displayName: 'Team notes',
    })

    const rows = await deps.documentIndex.listWorkspaces()
    const row = rows.find((r) => r.workspaceId === 'ws-echo')
    expect(row).toEqual({
      workspaceId: 'ws-echo',
      segment: 'team-notes',
      displayName: 'Team notes',
    })
  })

  it('a legacy workspace with no identity lists with the keys absent, not null', async () => {
    const deps = await getDefaultServerDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-legacy' })

    const rows = await deps.documentIndex.listWorkspaces()
    const row = rows.find((r) => r.workspaceId === 'ws-legacy')
    expect(row).toEqual({ workspaceId: 'ws-legacy' })
  })

  it('a bare re-create (the wb_document_create createWorkspace:true path) does not clobber stored identity', async () => {
    const deps = await getDefaultServerDeps()
    await deps.documentIndex.createWorkspace({
      workspaceId: 'ws-preserved',
      segment: 'kept',
      displayName: 'Kept',
    })

    // Every wbDocumentCreate({ createWorkspace: true }) call reaches this
    // bare shape — the identity claimed above must survive it.
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-preserved' })

    const rows = await deps.documentIndex.listWorkspaces()
    const row = rows.find((r) => r.workspaceId === 'ws-preserved')
    expect(row).toEqual({ workspaceId: 'ws-preserved', segment: 'kept', displayName: 'Kept' })
  })

  it('re-creating with identical fields is idempotent', async () => {
    const deps = await getDefaultServerDeps()
    const input = { workspaceId: 'ws-idem', segment: 'idem', displayName: 'Idem' }
    await deps.documentIndex.createWorkspace(input)
    await expect(deps.documentIndex.createWorkspace(input)).resolves.toBeUndefined()

    const rows = await deps.documentIndex.listWorkspaces()
    expect(rows.find((r) => r.workspaceId === 'ws-idem')).toEqual(input)
  })

  it('a second workspace claiming an already-taken segment is refused, and neither row is left partial', async () => {
    const deps = await getDefaultServerDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-first', segment: 'contested' })

    const err = await deps.documentIndex
      .createWorkspace({ workspaceId: 'ws-second', segment: 'contested' })
      .catch((e: unknown) => e)
    expect(isWorkspaceSegmentTakenError(err)).toBe(true)

    const rows = await deps.documentIndex.listWorkspaces()
    expect(rows.find((r) => r.workspaceId === 'ws-second')).toBeUndefined()
    expect(rows.find((r) => r.workspaceId === 'ws-first')).toEqual({
      workspaceId: 'ws-first',
      segment: 'contested',
    })
  })

  // The inbound half of zod-schema-discipline: what listWorkspaces serves
  // was validated on write, so the strict outbound workspaceSummarySchema
  // never meets a poisoned row.
  it('rejects a ULID-shaped segment at the boundary, before any row is written', async () => {
    const deps = await getDefaultServerDeps()
    await expect(
      deps.documentIndex.createWorkspace({
        workspaceId: 'ws-rejected',
        segment: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }),
    ).rejects.toThrow()

    const rows = await deps.documentIndex.listWorkspaces()
    expect(rows.find((r) => r.workspaceId === 'ws-rejected')).toBeUndefined()
  })

  it('rejects an empty displayName at the boundary, before any row is written', async () => {
    const deps = await getDefaultServerDeps()
    await expect(
      deps.documentIndex.createWorkspace({ workspaceId: 'ws-rejected-2', displayName: '' }),
    ).rejects.toThrow()

    const rows = await deps.documentIndex.listWorkspaces()
    expect(rows.find((r) => r.workspaceId === 'ws-rejected-2')).toBeUndefined()
  })
})

// The daemon's registry is the one `renameWorkspace` implementation the
// shared conformance suite does not run: its runners are the in-memory
// double, the browser's IndexedDB index, and the tree index over an
// in-memory registry. What is specific here is the mechanism — a single
// UPDATE against the `workspaces_segment_unique` index — so the cases below
// are about that, not about restating the contract.
describe('renameWorkspace — the daemon registry', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-ws-rename-test-'))
    await setupIsolatedDb()
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('writes both layers and serves them back through listWorkspaces', async () => {
    const deps = await getDefaultServerDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-rename', segment: 'before' })

    const renamed = await deps.documentIndex.renameWorkspace({
      workspaceId: 'ws-rename',
      segment: 'after',
      displayName: 'After',
    })

    expect(renamed).toEqual({
      workspaceId: 'ws-rename',
      segment: 'after',
      displayName: 'After',
    })
    const rows = await deps.documentIndex.listWorkspaces()
    expect(rows.find((r) => r.workspaceId === 'ws-rename')).toEqual(renamed)
    expect((await deps.documentIndex.resolveWorkspace('after'))?.workspaceId).toBe('ws-rename')
    expect(await deps.documentIndex.resolveWorkspace('before')).toBeNull()
  })

  // The unique index refuses the UPDATE itself, so there is no window
  // between a check and the write it authorises — and the row the refused
  // statement targeted is untouched, rather than half renamed.
  it('is refused by the unique index, leaving the row as it was', async () => {
    const deps = await getDefaultServerDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-holder', segment: 'contested' })
    await deps.documentIndex.createWorkspace({
      workspaceId: 'ws-asking',
      segment: 'asking',
      displayName: 'Asking',
    })

    const err = await deps.documentIndex
      .renameWorkspace({ workspaceId: 'ws-asking', segment: 'contested', displayName: 'Renamed' })
      .catch((e: unknown) => e)
    expect(isWorkspaceSegmentTakenError(err)).toBe(true)

    const rows = await deps.documentIndex.listWorkspaces()
    // The displayName the same call carried must not have landed either: a
    // refused rename is one operation refused, not a partial write.
    expect(rows.find((r) => r.workspaceId === 'ws-asking')).toEqual({
      workspaceId: 'ws-asking',
      segment: 'asking',
      displayName: 'Asking',
    })
  })

  it('names a workspace that had none, leaving its address alone', async () => {
    const deps = await getDefaultServerDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-unnamed', segment: 'keep-me' })

    const renamed = await deps.documentIndex.renameWorkspace({
      workspaceId: 'ws-unnamed',
      displayName: 'Now named',
    })

    expect(renamed).toEqual({
      workspaceId: 'ws-unnamed',
      segment: 'keep-me',
      displayName: 'Now named',
    })
  })

  // Zero rows updated is the only signal a single UPDATE gives, and it has
  // to mean "no such workspace" rather than "done".
  it('fails WorkspaceNotFoundError for a workspace the registry does not hold', async () => {
    const deps = await getDefaultServerDeps()
    await expect(
      deps.documentIndex.renameWorkspace({ workspaceId: 'ws-absent', displayName: 'nobody' }),
    ).rejects.toThrow(WorkspaceNotFoundError)
  })

  it('rejects a ULID-shaped segment at the boundary, before any row is written', async () => {
    const deps = await getDefaultServerDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-guarded', segment: 'fine' })

    await expect(
      deps.documentIndex.renameWorkspace({
        workspaceId: 'ws-guarded',
        segment: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }),
    ).rejects.toThrow()

    const rows = await deps.documentIndex.listWorkspaces()
    expect(rows.find((r) => r.workspaceId === 'ws-guarded')).toEqual({
      workspaceId: 'ws-guarded',
      segment: 'fine',
    })
  })
})
