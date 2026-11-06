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
const { saveDocument, listWorkspaces, workspaceRegistry } = await import('./document-store.js')
const { CorruptStoredDataError } = await import('./corrupt-stored-data.js')
const { resolveTestServerDeps } = await import('../routes/_test-helpers.js')
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
    await saveDocument('01QR94Q18PQ3B6P06BXBV4QXAG', 'a', new LoroDoc())
    await saveDocument('01QR94Q18PQ3B6P06BXBV4QXAH', 'a', new LoroDoc())

    const workspaces = await listWorkspaces()
    const ids = workspaces.map((s) => s.workspaceId)
    expect(ids).toContain('01QR94Q18PQ3B6P06BXBV4QXAG')
    expect(ids).toContain('01QR94Q18PQ3B6P06BXBV4QXAH')
  })

  // A row keyed before the re-key onto ULIDs is an old stored shape. It is
  // refused by its id, so the listing fails loudly instead of answering a
  // workspace no address can reach.
  it('refuses a stored row whose id is not a canonical ULID, naming it', async () => {
    await handle.db
      .insertInto('workspaces')
      .values({ id: 'default', displayName: null, segment: null, createdAt: 0, updatedAt: 0 })
      .execute()

    await expect(listWorkspaces()).rejects.toThrow(CorruptStoredDataError)
    await expect(listWorkspaces()).rejects.toThrow(/Workspace row "default"/)
    await expect(workspaceRegistry().listWorkspaces()).rejects.toThrow(/Workspace row "default"/)
    await expect(workspaceRegistry().findWorkspace({ workspaceId: 'default' })).rejects.toThrow(
      CorruptStoredDataError,
    )
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
    const deps = await resolveTestServerDeps(tempDir)
    await deps.documentIndex.createWorkspace({
      workspaceId: '01JYCKPSSQHJ33JAX81DSC7FZ5',
      segment: 'team-notes',
      displayName: 'Team notes',
    })

    const rows = await deps.documentIndex.listWorkspaces()
    const row = rows.find((r) => r.workspaceId === '01JYCKPSSQHJ33JAX81DSC7FZ5')
    expect(row).toEqual({
      workspaceId: '01JYCKPSSQHJ33JAX81DSC7FZ5',
      segment: 'team-notes',
      displayName: 'Team notes',
    })
  })

  it('a legacy workspace with no identity lists with the keys absent, not null', async () => {
    const deps = await resolveTestServerDeps(tempDir)
    await deps.documentIndex.createWorkspace({ workspaceId: '01QX3DJ36GPBTZ9X1YB3FWDG50' })

    const rows = await deps.documentIndex.listWorkspaces()
    const row = rows.find((r) => r.workspaceId === '01QX3DJ36GPBTZ9X1YB3FWDG50')
    expect(row).toEqual({ workspaceId: '01QX3DJ36GPBTZ9X1YB3FWDG50' })
  })

  it('a bare re-create (the wbDocumentCreate createWorkspace:true path) does not clobber stored identity', async () => {
    const deps = await resolveTestServerDeps(tempDir)
    await deps.documentIndex.createWorkspace({
      workspaceId: '01SATZEK9ZY7WGS9DCZ01R7M5F',
      segment: 'kept',
      displayName: 'Kept',
    })

    // Every wbDocumentCreate({ createWorkspace: true }) call reaches this
    // bare shape — the identity claimed above must survive it.
    await deps.documentIndex.createWorkspace({ workspaceId: '01SATZEK9ZY7WGS9DCZ01R7M5F' })

    const rows = await deps.documentIndex.listWorkspaces()
    const row = rows.find((r) => r.workspaceId === '01SATZEK9ZY7WGS9DCZ01R7M5F')
    expect(row).toEqual({
      workspaceId: '01SATZEK9ZY7WGS9DCZ01R7M5F',
      segment: 'kept',
      displayName: 'Kept',
    })
  })

  it('re-creating with identical fields is idempotent', async () => {
    const deps = await resolveTestServerDeps(tempDir)
    const input = {
      workspaceId: '01CK7V02492BHNYNRB070WY0VT',
      segment: 'idem',
      displayName: 'Idem',
    }
    await deps.documentIndex.createWorkspace(input)
    await expect(deps.documentIndex.createWorkspace(input)).resolves.toBeUndefined()

    const rows = await deps.documentIndex.listWorkspaces()
    expect(rows.find((r) => r.workspaceId === '01CK7V02492BHNYNRB070WY0VT')).toEqual(input)
  })

  it('a second workspace claiming an already-taken segment is refused, and neither row is left partial', async () => {
    const deps = await resolveTestServerDeps(tempDir)
    await deps.documentIndex.createWorkspace({
      workspaceId: '015J4D4NQT6WSFQJWK6AJR47RG',
      segment: 'contested',
    })

    const err = await deps.documentIndex
      .createWorkspace({ workspaceId: '01FQ39QDCDJFFBK9CXYFPM2JF7', segment: 'contested' })
      .catch((e: unknown) => e)
    expect(isWorkspaceSegmentTakenError(err)).toBe(true)

    const rows = await deps.documentIndex.listWorkspaces()
    expect(rows.find((r) => r.workspaceId === '01FQ39QDCDJFFBK9CXYFPM2JF7')).toBeUndefined()
    expect(rows.find((r) => r.workspaceId === '015J4D4NQT6WSFQJWK6AJR47RG')).toEqual({
      workspaceId: '015J4D4NQT6WSFQJWK6AJR47RG',
      segment: 'contested',
    })
  })

  // The inbound half of zod-schema-discipline: what listWorkspaces serves
  // was validated on write, so the strict outbound workspaceSummarySchema
  // never meets a poisoned row.
  it('rejects a ULID-shaped segment at the boundary, before any row is written', async () => {
    const deps = await resolveTestServerDeps(tempDir)
    await expect(
      deps.documentIndex.createWorkspace({
        workspaceId: '01BSK4EW4S1AP8DVCQBN01F82K',
        segment: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }),
    ).rejects.toThrow()

    const rows = await deps.documentIndex.listWorkspaces()
    expect(rows.find((r) => r.workspaceId === '01BSK4EW4S1AP8DVCQBN01F82K')).toBeUndefined()
  })

  it('rejects an empty displayName at the boundary, before any row is written', async () => {
    const deps = await resolveTestServerDeps(tempDir)
    await expect(
      deps.documentIndex.createWorkspace({
        workspaceId: '0162YDTMRMFHXD9MZTZ9HAYY7Y',
        displayName: '',
      }),
    ).rejects.toThrow()

    const rows = await deps.documentIndex.listWorkspaces()
    expect(rows.find((r) => r.workspaceId === '0162YDTMRMFHXD9MZTZ9HAYY7Y')).toBeUndefined()
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
    const deps = await resolveTestServerDeps(tempDir)
    await deps.documentIndex.createWorkspace({
      workspaceId: '01CB14DP1SFPYJQ27YTHP2HZCZ',
      segment: 'before',
    })

    const renamed = await deps.documentIndex.renameWorkspace({
      workspaceId: '01CB14DP1SFPYJQ27YTHP2HZCZ',
      segment: 'after',
      displayName: 'After',
    })

    expect(renamed).toEqual({
      workspaceId: '01CB14DP1SFPYJQ27YTHP2HZCZ',
      segment: 'after',
      displayName: 'After',
    })
    const rows = await deps.documentIndex.listWorkspaces()
    expect(rows.find((r) => r.workspaceId === '01CB14DP1SFPYJQ27YTHP2HZCZ')).toEqual(renamed)
    expect((await deps.documentIndex.resolveWorkspace('after'))?.workspaceId).toBe(
      '01CB14DP1SFPYJQ27YTHP2HZCZ',
    )
    expect(await deps.documentIndex.resolveWorkspace('before')).toBeNull()
  })

  // The unique index refuses the UPDATE itself, so there is no window
  // between a check and the write it authorises — and the row the refused
  // statement targeted is untouched, rather than half renamed.
  it('is refused by the unique index, leaving the row as it was', async () => {
    const deps = await resolveTestServerDeps(tempDir)
    await deps.documentIndex.createWorkspace({
      workspaceId: '01MYD5JHXXNFF0SJ7B9W29YQKM',
      segment: 'contested',
    })
    await deps.documentIndex.createWorkspace({
      workspaceId: '016JETMGXA27Z1VG9A07ESTCW3',
      segment: 'asking',
      displayName: 'Asking',
    })

    const err = await deps.documentIndex
      .renameWorkspace({
        workspaceId: '016JETMGXA27Z1VG9A07ESTCW3',
        segment: 'contested',
        displayName: 'Renamed',
      })
      .catch((e: unknown) => e)
    expect(isWorkspaceSegmentTakenError(err)).toBe(true)

    const rows = await deps.documentIndex.listWorkspaces()
    // The displayName the same call carried must not have landed either: a
    // refused rename is one operation refused, not a partial write.
    expect(rows.find((r) => r.workspaceId === '016JETMGXA27Z1VG9A07ESTCW3')).toEqual({
      workspaceId: '016JETMGXA27Z1VG9A07ESTCW3',
      segment: 'asking',
      displayName: 'Asking',
    })
  })

  it('names a workspace that had none, leaving its address alone', async () => {
    const deps = await resolveTestServerDeps(tempDir)
    await deps.documentIndex.createWorkspace({
      workspaceId: '01BPGTDJ59WBNAJE1R3QXWVQZ9',
      segment: 'keep-me',
    })

    const renamed = await deps.documentIndex.renameWorkspace({
      workspaceId: '01BPGTDJ59WBNAJE1R3QXWVQZ9',
      displayName: 'Now named',
    })

    expect(renamed).toEqual({
      workspaceId: '01BPGTDJ59WBNAJE1R3QXWVQZ9',
      segment: 'keep-me',
      displayName: 'Now named',
    })
  })

  // Zero rows updated is the only signal a single UPDATE gives, and it has
  // to mean "no such workspace" rather than "done".
  it('fails WorkspaceNotFoundError for a workspace the registry does not hold', async () => {
    const deps = await resolveTestServerDeps(tempDir)
    await expect(
      deps.documentIndex.renameWorkspace({
        workspaceId: '01HV1A108E81FBY2CA68PD9HE7',
        displayName: 'nobody',
      }),
    ).rejects.toThrow(WorkspaceNotFoundError)
  })

  it('rejects a ULID-shaped segment at the boundary, before any row is written', async () => {
    const deps = await resolveTestServerDeps(tempDir)
    await deps.documentIndex.createWorkspace({
      workspaceId: '01GTPJ2F7RQTH8MVY7VQHA326V',
      segment: 'fine',
    })

    await expect(
      deps.documentIndex.renameWorkspace({
        workspaceId: '01GTPJ2F7RQTH8MVY7VQHA326V',
        segment: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }),
    ).rejects.toThrow()

    const rows = await deps.documentIndex.listWorkspaces()
    expect(rows.find((r) => r.workspaceId === '01GTPJ2F7RQTH8MVY7VQHA326V')).toEqual({
      workspaceId: '01GTPJ2F7RQTH8MVY7VQHA326V',
      segment: 'fine',
    })
  })
})
