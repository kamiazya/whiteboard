import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  documentContainers,
  readSpatialCanvas,
  readWorkspaceDocuments,
  resolveWorkspaceDocumentById,
} from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
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

const { foldWorkspaceDocuments } = await import('./fold-workspace.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { getDb } = await import('./db/index.js')
const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'fold-ws-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

// Seeded the way an OLD build left documents — a `documents` row plus a
// per-document Loro record — written RAW, because the current `saveDocument`
// always lands on the workspace tree and would leave this fold nothing to do.
async function seedLegacy(
  workspaceId: string,
  path: string,
  text: string,
  kind: string | null = 'spatial',
): Promise<string> {
  const doc = new LoroDoc()
  doc.getMap('nodes').set('n1', { id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text })
  doc.commit()
  const db = await getDb(tempDir)
  const documentId = generateDocumentId()
  await seedLegacyRecord(documentId, doc)
  const now = Date.now()
  await db
    .insertInto('workspaces')
    .values({ id: workspaceId, createdAt: now, updatedAt: now })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()
  await db
    .insertInto('documents')
    .values({
      id: documentId,
      workspaceId,
      path,
      displayName: null,
      isPinned: 0,
      pinOrder: null,
      currentBranch: 'main',
      createdAt: now,
      updatedAt: now,
      kind,
    })
    .execute()
  return documentId
}

/** Just the per-document content record, for re-seeding a stray leftover. */
async function seedLegacyRecord(documentId: string, doc: LoroDoc): Promise<void> {
  const db = await getDb(tempDir)
  const store = new LibsqlDocumentStore(db)
  const { manifest, chunks } = chunkSnapshot(
    new Uint8Array(doc.export({ mode: 'snapshot' })),
    1_000_000,
  )
  await store.saveSnapshot({
    docRef: { kind: 'document', workspaceId: 'ws-a', documentId },
    manifest,
    chunks,
    frontier: new Uint8Array(doc.oplogVersion().encode()),
  })
}

async function legacyRecord(documentId: string) {
  const db = await getDb(tempDir)
  return new LibsqlDocumentStore(db).loadSnapshot({
    docRef: { kind: 'document', workspaceId: 'ws-a', documentId },
  })
}

async function openWorkspace(workspaceId: string) {
  const db = await getDb(tempDir)
  return new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(db)).open(workspaceId)
}

it('folds every documents-table row into its workspace document, content included', async () => {
  await seedLegacy('ws-a', 'design', 'from design')
  await seedLegacy('ws-a', 'archive/notes', 'from notes')
  await seedLegacy('ws-b', 'other', 'other workspace')

  const report = await foldWorkspaceDocuments()
  expect(report).toEqual({ folded: 3, skipped: 0, deleted: 0 })

  const workspace = await openWorkspace('ws-a')
  expect(workspace).not.toBeNull()
  if (workspace === null) return
  const entries = readWorkspaceDocuments(workspace)
  expect(entries.map((entry) => entry.path).sort()).toEqual(['archive/notes', 'design'])
  const design = entries.find((entry) => entry.path === 'design')
  expect(design).toBeDefined()
  if (design === undefined) return
  const canvas = readSpatialCanvas(documentContainers(workspace, design.documentId))
  expect(canvas.nodes[0]?.type === 'text' ? canvas.nodes[0].text : null).toBe('from design')

  // The OTHER workspace got its own document — one Loro document per
  // workspace, never one per daemon.
  const other = await openWorkspace('ws-b')
  expect(other === null ? [] : readWorkspaceDocuments(other).map((entry) => entry.path)).toEqual([
    'other',
  ])
})

it('carries the row timestamps into node meta instead of stamping fold time', async () => {
  const db = await getDb(tempDir)
  const documentId = await seedLegacy('ws-a', 'design', 'timestamped')
  await db
    .updateTable('documents')
    .set({ createdAt: 111, updatedAt: 222 })
    .where('id', '=', documentId)
    .execute()

  await foldWorkspaceDocuments()

  const workspace = await openWorkspace('ws-a')
  expect(workspace).not.toBeNull()
  if (workspace === null) return
  const entry = resolveWorkspaceDocumentById(workspace, documentId)
  expect(entry?.createdAt).toBe(111)
  expect(entry?.updatedAt).toBe(222)
})

it('carries pins and the branch HEAD into the workspace record', async () => {
  // Reads answer from the tree after S7, so row-only pin/HEAD state on a
  // pre-fold database must be relocated by the fold or it silently
  // vanishes at the flip.
  const db = await getDb(tempDir)
  const pinnedId = await seedLegacy('ws-a', 'pinned-doc', 'pin me')
  const headId = await seedLegacy('ws-a', 'branched-doc', 'branch me')
  await db
    .updateTable('documents')
    .set({ isPinned: 1, pinOrder: 0 })
    .where('id', '=', pinnedId)
    .execute()
  await db
    .updateTable('documents')
    .set({ currentBranch: 'feature' })
    .where('id', '=', headId)
    .execute()

  await foldWorkspaceDocuments()

  const workspace = await openWorkspace('ws-a')
  expect(workspace).not.toBeNull()
  if (workspace === null) return
  const { readPinnedDocumentIds } = await import('@kamiazya/whiteboard-loro-adapter')
  expect(readPinnedDocumentIds(workspace)).toEqual([pinnedId])
  expect(resolveWorkspaceDocumentById(workspace, headId)?.currentBranch).toBe('feature')
})

it('is idempotent, and picks up documents created between runs', async () => {
  await seedLegacy('ws-a', 'design', 'first')
  expect((await foldWorkspaceDocuments()).folded).toBe(1)
  expect((await foldWorkspaceDocuments()).folded).toBe(0)

  await seedLegacy('ws-a', 'later', 'second')
  expect((await foldWorkspaceDocuments()).folded).toBe(1)
})

it('DELETES a pre-kind row instead of leaving it on a plane nothing serves anymore', async () => {
  // A kind-less row is this project's own data defect from before kinds
  // existed — there are no external users whose documents it could be, so
  // the fold removes it (row + content record) rather than keeping a legacy
  // read path alive for it.
  const documentId = await seedLegacy('ws-a', 'no-kind', 'kindless', null)
  // Migration 0016 dropped the documents FK, so versions/branches rows no
  // longer cascade — this delete path must sweep them explicitly, exactly
  // like documentTeardown's bracket does. Seed one of each to prove it.
  const db = await getDb(tempDir)
  await db
    .insertInto('branches')
    .values({
      documentId,
      workspaceId: 'ws-a',
      name: 'main',
      tipFrontiers: '',
      color: null,
      sourceBranchName: null,
      sourceVersionId: null,
      createdAt: Date.now(),
    })
    .execute()
  await db
    .insertInto('versions')
    .values({
      id: 'v-prekind',
      documentId,
      workspaceId: 'ws-a',
      branchName: 'main',
      auto: 0,
      label: 'stale',
      operatorKind: 'system',
      operatorPeerId: 'peer-1',
      operatorDisplayName: null,
      operatorAgentId: null,
      operatorWorkspaceId: null,
      elementCount: 0,
      frontiers: 'AAECAw==',
      hasThumbnail: 0,
      createdAt: Date.now(),
    })
    .execute()

  const report = await foldWorkspaceDocuments()
  expect(report).toEqual({ folded: 0, skipped: 0, deleted: 1 })

  expect(
    await db.selectFrom('documents').select(['id']).where('id', '=', documentId).executeTakeFirst(),
  ).toBeUndefined()
  expect(await legacyRecord(documentId)).toBeNull()
  expect(
    await db
      .selectFrom('branches')
      .select(['name'])
      .where('documentId', '=', documentId)
      .executeTakeFirst(),
  ).toBeUndefined()
  expect(
    await db
      .selectFrom('versions')
      .select(['id'])
      .where('documentId', '=', documentId)
      .executeTakeFirst(),
  ).toBeUndefined()
})

it('sweeps versions/branches rows whose document exists nowhere; live rows survive', async () => {
  const db = await getDb(tempDir)
  const now = Date.now()
  const insertVersion = (id: string, documentId: string, workspaceId: string) =>
    db
      .insertInto('versions')
      .values({
        id,
        documentId,
        workspaceId,
        branchName: 'main',
        auto: 0,
        label: null,
        operatorKind: 'system',
        operatorPeerId: 'peer-1',
        operatorDisplayName: null,
        operatorAgentId: null,
        operatorWorkspaceId: null,
        elementCount: 0,
        frontiers: 'AAECAw==',
        hasThumbnail: 0,
        createdAt: now,
      })
      .execute()
  const insertBranch = (documentId: string, workspaceId: string, name: string) =>
    db
      .insertInto('branches')
      .values({
        documentId,
        workspaceId,
        name,
        tipFrontiers: '',
        color: null,
        sourceBranchName: null,
        sourceVersionId: null,
        createdAt: now,
      })
      .execute()

  // Tree-resident after the fold: its rows are LIVE.
  const liveId = await seedLegacy('ws-a', 'kept', 'content')
  await insertVersion('v-live', liveId, 'ws-a')
  await insertBranch(liveId, 'ws-a', 'main')
  // Row-only (no readable content, so the fold skips it): its documents row
  // still names it, so its version history is live too.
  const skippedId = generateDocumentId()
  await db
    .insertInto('documents')
    .values({
      id: skippedId,
      workspaceId: 'ws-a',
      path: 'skipped',
      displayName: null,
      isPinned: 0,
      pinOrder: null,
      currentBranch: 'main',
      createdAt: now,
      updatedAt: now,
      kind: 'spatial',
    })
    .execute()
  await insertVersion('v-skipped', skippedId, 'ws-a')
  // The crash-window orphan documentTeardown's non-atomic delete can leave:
  // a documentId that exists in no tree, no documents row, no trash.
  const ghostId = generateDocumentId()
  await insertVersion('v-ghost', ghostId, 'ws-a')
  await insertBranch(ghostId, 'ws-a', 'stale')
  // A workspace with rows but NO openable workspace record: conservative —
  // nothing is swept where the address book itself cannot be read.
  await db
    .insertInto('workspaces')
    .values({ id: 'ws-recordless', createdAt: now, updatedAt: now })
    .execute()
  await insertVersion('v-recordless', generateDocumentId(), 'ws-recordless')

  await foldWorkspaceDocuments()

  const versionIds = (await db.selectFrom('versions').select(['id']).execute()).map((r) => r.id)
  expect(versionIds.sort()).toEqual(['v-live', 'v-recordless', 'v-skipped'])
  const branchDocs = (await db.selectFrom('branches').select(['documentId']).execute()).map(
    (r) => r.documentId,
  )
  expect(branchDocs).toEqual([liveId])
})

it('sweeps the legacy content record once a document is folded onto the tree', async () => {
  // Legacy per-document version rows are gone before any fold runs —
  // migration 0015 deleted them with the scope flag — so the sweep here is
  // only about the content record.
  const documentId = await seedLegacy('ws-a', 'design', 'to be swept')

  await foldWorkspaceDocuments()

  expect(await legacyRecord(documentId)).toBeNull()
  // The fold itself still worked.
  const workspace = await openWorkspace('ws-a')
  expect(workspace === null ? null : resolveWorkspaceDocumentById(workspace, documentId)).not.toBe(
    null,
  )
})

it('sweeps a stray legacy record of an ALREADY-resident document on a later boot', async () => {
  const documentId = await seedLegacy('ws-a', 'design', 'first boot')
  await foldWorkspaceDocuments()
  expect(await legacyRecord(documentId)).toBeNull()

  // A leftover reappears (e.g. a record an interrupted earlier build left
  // behind after the doc was already tree-resident) — the next boot's fold
  // sweeps it even though there is nothing to fold.
  const stray = new LoroDoc()
  stray.getMap('nodes').set('n1', { text: 'stray' })
  stray.commit()
  await seedLegacyRecord(documentId, stray)

  const report = await foldWorkspaceDocuments()
  expect(report.folded).toBe(0)
  expect(await legacyRecord(documentId)).toBeNull()
})
