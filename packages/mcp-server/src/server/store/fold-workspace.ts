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
}

export async function foldWorkspaceDocuments(): Promise<FoldReport> {
  await prepareDataDir(getDataDir())
  const db = await getDb(getDataDir())
  const docs = new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(db))

  const rows = await db
    .selectFrom('documents')
    .select(['id', 'workspaceId', 'path', 'displayName', 'kind'])
    .execute()

  const byWorkspace = new Map<string, typeof rows>()
  for (const row of rows) {
    const bucket = byWorkspace.get(row.workspaceId) ?? []
    bucket.push(row)
    byWorkspace.set(row.workspaceId, bucket)
  }

  let folded = 0
  let skipped = 0
  for (const [workspaceId, members] of byWorkspace) {
    const workspace = await docs.create(workspaceId)
    for (const row of members) {
      if (resolveWorkspaceDocumentById(workspace, row.id) !== null) continue
      // A pre-kind row has content but no recorded format, and adopting it
      // would mean inventing one. It keeps being served by the old path.
      const kind = documentKindSchema.safeParse(row.kind)
      if (!kind.success) {
        skipped += 1
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
        },
        source,
      )
      // Saved PER DOCUMENT, so a crash mid-fold loses at most the one in
      // flight — the next startup derives it as still-pending and retries.
      await docs.save(workspaceId, workspace)
      folded += 1
    }
  }
  return { folded, skipped }
}
