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
  resolveWorkspaceDocumentById,
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
    .select(['id', 'workspaceId', 'path', 'displayName', 'kind', 'createdAt', 'updatedAt'])
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
      // Saved PER DOCUMENT, so a crash mid-fold loses at most the one in
      // flight — the next startup derives it as still-pending and retries.
      // The sweep runs strictly AFTER the save: until the tree write is
      // durable, the legacy record is still the document's only copy.
      await docs.save(workspaceId, workspace)
      await sweepLegacy(workspaceId, row.id)
      folded += 1
    }
  }
  return { folded, skipped, deleted }
}
