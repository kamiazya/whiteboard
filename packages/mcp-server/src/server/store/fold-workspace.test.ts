import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  documentContainers,
  readSpatialCanvas,
  readWorkspaceDocuments,
  resolveWorkspaceDocumentById,
} from '@kamiazya/whiteboard-loro-adapter'
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

const { saveDocument } = await import('./document-store.js')
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
// per-document Loro record — written directly, because `saveDocument` with a
// kind now lands on the workspace tree and would leave this fold nothing to
// do.
async function seedCanvas(workspaceId: string, path: string, text: string): Promise<void> {
  const doc = new LoroDoc()
  doc.getMap('nodes').set('n1', { id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text })
  doc.commit()
  await saveDocument(workspaceId, path, doc)
  const db = await getDb(tempDir)
  await db
    .updateTable('documents')
    .set({ kind: 'spatial' })
    .where('workspaceId', '=', workspaceId)
    .where('path', '=', path)
    .execute()
}

async function openWorkspace(workspaceId: string) {
  const db = await getDb(tempDir)
  return new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(db)).open(workspaceId)
}

it('folds every documents-table row into its workspace document, content included', async () => {
  await seedCanvas('ws-a', 'design', 'from design')
  await seedCanvas('ws-a', 'archive/notes', 'from notes')
  await seedCanvas('ws-b', 'other', 'other workspace')

  const report = await foldWorkspaceDocuments()
  expect(report).toEqual({ folded: 3, skipped: 0 })

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

it('is idempotent, and picks up documents created between runs', async () => {
  await seedCanvas('ws-a', 'design', 'first')
  expect((await foldWorkspaceDocuments()).folded).toBe(1)
  expect((await foldWorkspaceDocuments()).folded).toBe(0)

  await seedCanvas('ws-a', 'later', 'second')
  expect((await foldWorkspaceDocuments()).folded).toBe(1)
})

it('skips a pre-kind row rather than inventing a format for it', async () => {
  // `saveDocument` with no kind writes `kind: null` — exactly the pre-kind
  // row shape the fold must not guess about.
  const doc = new LoroDoc()
  doc.getMap('nodes').set('n1', { text: 'kindless' })
  doc.commit()
  await saveDocument('ws-a', 'no-kind', doc)

  const report = await foldWorkspaceDocuments()
  expect(report).toEqual({ folded: 0, skipped: 1 })

  const workspace = await openWorkspace('ws-a')
  expect(workspace).not.toBeNull()
  if (workspace === null) return
  const db = await getDb(tempDir)
  const row = await db
    .selectFrom('documents')
    .select(['id'])
    .where('path', '=', 'no-kind')
    .executeTakeFirst()
  expect(row).toBeDefined()
  expect(row === undefined ? null : resolveWorkspaceDocumentById(workspace, row.id)).toBeNull()
})
