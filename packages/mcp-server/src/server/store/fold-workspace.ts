/**
 * Folds the daemon's per-document Loro records into each workspace's
 * workspace document — the daemon half of the same startup step the browser
 * runs, over the same shared machinery.
 *
 * The work list is DERIVED, exactly as in the browser: a document is pending
 * when the `documents` table has a row for it and the workspace tree does
 * not. A crash needs no cleanup (what was folded is not work anymore), and a
 * document created after this build but before its write path moves to the
 * tree is picked up at the next startup.
 *
 * This fold also ENDS the legacy plane rather than coexisting with it:
 * - A pre-kind row (kind: null) is DELETED, row and content record both.
 *   It is this project's own data defect from before kinds existed — there
 *   are no external users whose documents it could be — and keeping a whole
 *   read path alive for it is what forced two storage planes to coexist.
 * - A tree-resident document's leftover per-document record is swept, along
 *   with the version rows whose frontiers point into that record's oplog
 *   (they can never be checked out again once the record is gone).
 * The one thing still served from a legacy record afterwards is a document
 * whose stored content would not load — the fold cannot copy what it cannot
 * read, so the damaged record stays where the corruption error can name it.
 */
import {
  adoptWorkspaceDocument,
  readWorkspaceDocuments,
  resolveWorkspaceDocumentById,
  setWorkspacePinned,
  updateWorkspaceDocumentMeta,
} from '@kamiazya/whiteboard-loro-adapter'
import { documentKindSchema } from '@kamiazya/whiteboard-model'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { getDataDir } from '../config.js'
import { getLogger } from '../log.js'
import { getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'
import { loadDocument } from './document-store.js'
import { LibsqlDocumentStore } from './libsql/libsql-document-store.js'

export interface FoldReport {
  folded: number
  skipped: number
  /** Pre-kind rows removed outright (row + content record). */
  deleted: number
}

export async function foldWorkspaceDocuments(): Promise<FoldReport> {
  await prepareDataDir(getDataDir())
  const db = await getDb(getDataDir())
  const store = new LibsqlDocumentStore(db)
  const docs = new DocumentStoreWorkspaceDocs(store)

  const rows = await db
    .selectFrom('documents')
    .select([
      'id',
      'workspaceId',
      'path',
      'displayName',
      'kind',
      'createdAt',
      'updatedAt',
      'isPinned',
      'pinOrder',
      'currentBranch',
    ])
    .execute()

  const byWorkspace = new Map<string, typeof rows>()
  for (const row of rows) {
    const bucket = byWorkspace.get(row.workspaceId) ?? []
    bucket.push(row)
    byWorkspace.set(row.workspaceId, bucket)
  }

  // Version rows anchored to a legacy record's oplog no longer exist by the
  // time this runs: migration 0015 deleted them along with the scope flag,
  // so the sweep is only about the content record itself.
  async function sweepLegacy(workspaceId: string, documentId: string): Promise<void> {
    await store.deleteDoc({ docRef: { kind: 'document', workspaceId, documentId } })
  }

  let folded = 0
  let skipped = 0
  let deleted = 0
  for (const [workspaceId, members] of byWorkspace) {
    const workspace = await docs.create(workspaceId)
    const foldedThisRun: typeof members = []
    for (const row of members) {
      const kind = documentKindSchema.safeParse(row.kind)
      if (resolveWorkspaceDocumentById(workspace, row.id) !== null) {
        // Already tree-resident: nothing to fold, but an interrupted earlier
        // boot may have left the per-document record behind — sweep it.
        await sweepLegacy(workspaceId, row.id)
        continue
      }
      if (!kind.success) {
        await db.deleteFrom('documents').where('id', '=', row.id).execute()
        // Migration 0016 dropped the documents FK, so nothing cascades:
        // every path that deletes a documents row sweeps the dependent rows
        // itself, this one included (documentTeardown's bracket is the
        // other).
        await db.deleteFrom('versions').where('documentId', '=', row.id).execute()
        await db.deleteFrom('branches').where('documentId', '=', row.id).execute()
        await sweepLegacy(workspaceId, row.id)
        getLogger('fold-workspace').notice(
          { workspaceId, path: row.path },
          'deleted a pre-kind document (own pre-release data defect; nothing serves it anymore)',
        )
        deleted += 1
        continue
      }
      let source: Awaited<ReturnType<typeof loadDocument>>
      try {
        source = await loadDocument(workspaceId, row.path)
      } catch (err) {
        // Unreadable content folds NOTHING rather than an empty document; the
        // old record stays the damaged document's home. Logged because the
        // daemon has a logger where the browser has only a report object.
        getLogger('fold-workspace').warning(
          { workspaceId, path: row.path, err },
          'skipped a document whose stored content would not load',
        )
        skipped += 1
        continue
      }
      adoptWorkspaceDocument(
        workspace,
        {
          path: row.path,
          documentId: row.id,
          kind: kind.data,
          ...(row.displayName === null ? {} : { name: row.displayName }),
          // The row's own history, not fold time — a fold is a relocation,
          // not an edit.
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
        source,
      )
      // Row-only state relocates with the document (S7 reads answer from
      // the tree): the HEAD pointer, and — below, ordered across the whole
      // workspace — its pin. Only for THIS run's folds: a row a later boot
      // still holds must not re-pin a document the user has since unpinned
      // in the tree.
      if (row.currentBranch !== 'main') {
        updateWorkspaceDocumentMeta(workspace, row.id, { currentBranch: row.currentBranch })
      }
      foldedThisRun.push(row)
      // Saved PER DOCUMENT, so a crash mid-fold loses at most the one in
      // flight — the next startup derives it as still-pending and retries.
      // The sweep runs strictly AFTER the save: until the tree write is
      // durable, the legacy record is still the document's only copy.
      await docs.save(workspaceId, workspace)
      await sweepLegacy(workspaceId, row.id)
      folded += 1
    }
    const pinnedFolds = foldedThisRun
      .filter((row) => row.isPinned === 1)
      .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0))
    if (pinnedFolds.length > 0) {
      for (const row of pinnedFolds) setWorkspacePinned(workspace, row.id, true)
      await docs.save(workspaceId, workspace)
    }
  }

  // Since migration 0016 dropped the documents FK, a crash between
  // documentTeardown's row delete and its explicit versions/branches sweeps
  // can strand rows for a document that exists nowhere. This is the
  // compensating sweep: a row is an orphan when its documentId is neither in
  // the workspace tree nor in the documents table. Conservative on purpose —
  // a workspace whose record cannot be OPENED is left alone, because the
  // address book itself is the evidence of what is live.
  await sweepOrphanVersionRows(db, docs)

  return { folded, skipped, deleted }
}

async function sweepOrphanVersionRows(
  db: Awaited<ReturnType<typeof getDb>>,
  docs: DocumentStoreWorkspaceDocs,
): Promise<void> {
  const workspaceIds = new Set<string>()
  for (const table of ['versions', 'branches'] as const) {
    const rows = await db.selectFrom(table).select(['workspaceId']).distinct().execute()
    for (const row of rows) workspaceIds.add(row.workspaceId)
  }
  for (const workspaceId of workspaceIds) {
    let workspace: Awaited<ReturnType<typeof docs.open>>
    try {
      workspace = await docs.open(workspaceId)
    } catch {
      continue
    }
    if (workspace === null) continue
    const live = new Set(readWorkspaceDocuments(workspace).map((entry) => entry.documentId))
    const legacyRows = await db
      .selectFrom('documents')
      .select(['id'])
      .where('workspaceId', '=', workspaceId)
      .execute()
    for (const row of legacyRows) live.add(row.id)
    for (const table of ['versions', 'branches'] as const) {
      const referenced = await db
        .selectFrom(table)
        .select(['documentId'])
        .distinct()
        .where('workspaceId', '=', workspaceId)
        .execute()
      for (const { documentId } of referenced) {
        if (live.has(documentId)) continue
        await db
          .deleteFrom(table)
          .where('workspaceId', '=', workspaceId)
          .where('documentId', '=', documentId)
          .execute()
        getLogger('fold-workspace').notice(
          { workspaceId, documentId, table },
          'swept rows for a document that exists nowhere (crash-window orphan)',
        )
      }
    }
  }
}
