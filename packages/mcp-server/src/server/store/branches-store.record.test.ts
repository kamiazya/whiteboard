/**
 * Where the daemon KEEPS a branch.
 *
 * Until now: a `branches` row. That row is the whole reason the browser
 * keeper has no variations — it has no SQLite, and a row is not something a
 * replica can carry. A branch is a name and a frontier of the workspace
 * RECORD, and the record already reaches every replica, so the record is
 * where it belongs.
 *
 * Moving it is not only about the browser. A workspace promoted from a
 * browser to the daemon (ADR-0023) arrives as a record; branches kept
 * anywhere else would be invisible on the other side of that move, and a
 * variation that silently does not survive a promotion is exactly the kind of
 * loss nothing goes red for.
 *
 * The migration is per document and read-through: a document whose branches
 * are still rows reads them, and the first write moves it to the plane and
 * drops its rows. Nothing folds at boot, so there is no partial fold to
 * recover from and no marker to keep in step.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Declare this first because vi.mock is hoisted.
let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { loadDocumentBranches, createBranch, updateBranchTip } = await import('./branches-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { _resetWorkspaceLocksForTests } = await import('./workspace-lock.js')
const { saveDocument, openWorkspaceDocIfStored } = await import('./document-store.js')
const { getDb } = await import('./db/index.js')
const { resolveWorkspaceDocument } = await import('@kamiazya/whiteboard-loro-adapter')
const { readWorkspaceBranchTips } = await import('@kamiazya/whiteboard-history')
const { LoroDoc } = await import('loro-crdt')

const WORKSPACE = 'sess-record'
const PATH = 'canvas-x'

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

async function branchRowNames(): Promise<string[]> {
  const db = await getDb(tempDir)
  const rows = await db.selectFrom('branches').select(['name']).orderBy('name', 'asc').execute()
  return rows.map((r) => r.name)
}

/** The documentId the record answers for the seeded path. */
async function documentId(): Promise<string> {
  const record = await openWorkspaceDocIfStored(WORKSPACE)
  if (record === null) throw new Error('no workspace record')
  const entry = resolveWorkspaceDocument(record, PATH)
  if (entry === null) throw new Error(`no document at ${PATH}`)
  return entry.documentId
}

/** Seeds a branch the way the pre-plane daemon did: as a row, and nothing else. */
async function seedBranchRow(name: string, tipFrontiers: string): Promise<void> {
  const db = await getDb(tempDir)
  await db
    .insertInto('branches')
    .values({
      documentId: await documentId(),
      workspaceId: WORKSPACE,
      name,
      tipFrontiers,
      color: '#e03131',
      sourceBranchName: null,
      sourceVersionId: null,
      createdAt: Date.parse('2026-01-02T03:04:05.000Z'),
    })
    .execute()
}

describe('branches on the workspace record', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-branches-record-'))
    handle = await createIsolatedDb({ dataDir: tempDir })
    await saveDocument(WORKSPACE, PATH, new LoroDoc(), { kind: 'spatial' })
  })

  afterEach(async () => {
    await handle.dispose()
    await rm(tempDir, { recursive: true, force: true })
    _resetWorkspaceLocksForTests()
  })

  it('answers a created branch from the record, with no row behind it', async () => {
    await createBranch(WORKSPACE, PATH, { name: 'draft' })

    // The discriminator: the rows are gone, so the read below cannot be
    // coming from them. Asserting only that the branch reads back would pass
    // against the row-backed store unchanged.
    expect(await branchRowNames()).toEqual([])
    const state = await loadDocumentBranches(WORKSPACE, PATH)
    expect(state.branches.map((b) => b.name).sort()).toEqual(['draft', 'main'])
  })

  it('still reads a branch that exists only as a row, so no stored variation is lost', async () => {
    await seedBranchRow('legacy', 'AQID')

    const state = await loadDocumentBranches(WORKSPACE, PATH)

    expect(state.branches.map((b) => b.name)).toEqual(['legacy'])
    expect(state.branches[0]?.tipFrontiers).toBe('AQID')
  })

  it('moves a row-backed document onto the record the first time it is written', async () => {
    await seedBranchRow('legacy', 'AQID')

    await updateBranchTip(WORKSPACE, PATH, 'legacy', 'BAUG')

    expect(await branchRowNames()).toEqual([])
    const state = await loadDocumentBranches(WORKSPACE, PATH)
    expect(state.branches.map((b) => b.name)).toEqual(['legacy'])
    expect(state.branches[0]?.tipFrontiers).toBe('BAUG')
  })

  it('answers every tip in the workspace from the record alone, across documents', async () => {
    // What the retired `branches.workspaceId` column bought: a
    // workspace-scoped read with no join. Compaction needs it — a cut that
    // drops history a tip still needs makes that variation uncheckoutable —
    // and it is the one question a per-document read cannot answer. On the
    // record the column is not needed at all: the tree IS the scope.
    await saveDocument(WORKSPACE, 'canvas-y', new LoroDoc(), { kind: 'spatial' })
    await createBranch(WORKSPACE, PATH, { name: 'draft', initialTipFrontiers: 'AQID' })
    await createBranch(WORKSPACE, 'canvas-y', { name: 'other', initialTipFrontiers: 'BAUG' })

    const record = await openWorkspaceDocIfStored(WORKSPACE)
    if (record === null) throw new Error('no workspace record')
    const tips = readWorkspaceBranchTips(record)

    expect(tips.map((t) => `${t.name}=${t.tipFrontiers}`).sort()).toEqual([
      'draft=AQID',
      'main=',
      'main=',
      'other=BAUG',
    ])
  })

  it('keeps another document’s rows when one document moves', async () => {
    await saveDocument(WORKSPACE, 'canvas-y', new LoroDoc(), { kind: 'spatial' })
    const db = await getDb(tempDir)
    const other = resolveWorkspaceDocument(
      (await openWorkspaceDocIfStored(WORKSPACE)) as InstanceType<typeof LoroDoc>,
      'canvas-y',
    )
    await db
      .insertInto('branches')
      .values({
        documentId: other?.documentId ?? '',
        workspaceId: WORKSPACE,
        name: 'other-doc',
        tipFrontiers: '',
        color: '#e03131',
        sourceBranchName: null,
        sourceVersionId: null,
        createdAt: Date.now(),
      })
      .execute()

    await createBranch(WORKSPACE, PATH, { name: 'draft' })

    // Per document, not per workspace: a write to one document must not
    // retire another's rows before anything has read them onto its plane.
    expect(await branchRowNames()).toEqual(['other-doc'])
  })
})
