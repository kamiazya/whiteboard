import { documentIdSchema, generateDocumentId } from '@kamiazya/whiteboard-model'
import type {
  CreateDocumentInput,
  CreateWorkspaceInput,
  DeleteDocumentInput,
  DocumentEntry,
  DocumentIndex,
  ListDocumentsInput,
  MoveDocumentInput,
  ResolveDocumentByIdInput,
  ResolveDocumentInput,
  SetDocumentNameInput,
} from '@kamiazya/whiteboard-ports'
import {
  compareDocumentPaths,
  DocumentMoveIntoSelfError,
  DocumentNotFoundError,
  DocumentPathTakenError,
  isSelfOrDescendant,
  planSubtreeMove,
  WorkspaceNotFoundError,
} from '@kamiazya/whiteboard-ports'
import { getLogger } from '../log.js'
import { deleteDocumentRow } from './db/delete-document-row.js'
import type { Database } from './db/index.js'
import { upsertWorkspaceRow } from './db/upsert-workspace.js'
import { evictDoc } from './doc-cache.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

/**
 * A row becomes an entry. `displayName` is null for a document with no name
 * of its own, and the port says absent rather than null, so the key is left
 * off entirely instead of carrying a null a reader would have to re-check.
 */
function toEntry(row: {
  id: string
  path: string
  kind: string | null
  displayName: string | null
  updatedAt: number
}): DocumentEntry {
  return {
    documentId: row.id,
    path: row.path,
    ...(row.kind === null ? {} : { kind: row.kind as DocumentEntry['kind'] }),
    ...(row.displayName === null ? {} : { name: row.displayName }),
    // The column is epoch millis; the port publishes ISO 8601, which is what
    // every reader of it compares and formats. Converted here rather than at
    // each caller, so the storage representation stops at this boundary.
    updatedAt: new Date(row.updatedAt).toISOString(),
  }
}

/**
 * `DocumentIndex` over the daemon's `documents` table — the store the user's
 * canvas list, versions, branches and file GC already hang off, which is what
 * makes an agent-created document one a user can see.
 *
 * Every row-minting site in this codebase (`createDocument` here,
 * `saveDocument`, and `upsertCanvasRow` shared by the version/name/branch
 * stores) now assigns a ULID: `documentIdSchema` in the port's
 * `DocumentEntry` accepts only that shape, and migrations 0008 and 0012 swept
 * every nanoid row minted before each fix shipped. A non-ULID row reaching
 * `listDocuments` today is not an expected legacy shape — it is evidence one
 * of those three guarantees broke — so it is still excluded (one bad row must
 * not fail output validation for the entire listing) but logged as loudly as
 * corruption, not as an anticipated skip.
 */
const log = getLogger('document-index')

export class SqliteDocumentIndex implements DocumentIndex {
  constructor(private readonly db: Database) {}

  async createWorkspace({ workspaceId }: CreateWorkspaceInput): Promise<void> {
    await withWorkspaceWriteLock(workspaceId, async () => {
      await upsertWorkspaceRow(this.db, workspaceId)
    })
  }

  async listWorkspaces(): Promise<{ workspaceId: string }[]> {
    const rows = await this.db.selectFrom('workspaces').select(['id']).execute()
    return rows.map((row) => ({ workspaceId: row.id }))
  }

  async createDocument({
    workspaceId,
    path,
    kind,
    name,
  }: CreateDocumentInput): Promise<DocumentEntry> {
    return withWorkspaceWriteLock(workspaceId, async () => {
      const workspace = await this.db
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', workspaceId)
        .executeTakeFirst()
      if (!workspace) {
        throw new WorkspaceNotFoundError(workspaceId)
      }
      const documentId = generateDocumentId()
      const now = Date.now()
      // One statement, so the check and the claim cannot be separated: the
      // unique (workspaceId, path) index decides, and a loser inserts nothing.
      const inserted = await this.db
        .insertInto('documents')
        .values({
          id: documentId,
          workspaceId,
          path: path,
          displayName: name ?? null,
          isPinned: 0,
          pinOrder: null,
          currentBranch: 'main',
          createdAt: now,
          updatedAt: now,
          kind,
        })
        .onConflict((oc) => oc.columns(['workspaceId', 'path']).doNothing())
        .executeTakeFirst()

      if ((inserted.numInsertedOrUpdatedRows ?? 0n) === 0n) {
        throw new DocumentPathTakenError(workspaceId, path)
      }
      // `now` rather than a re-read: it is the value just written, and a
      // create whose returned entry disagrees with a later `resolveDocument`
      // is what the conformance suite exists to catch.
      return {
        documentId,
        path,
        kind,
        ...(name === undefined ? {} : { name }),
        updatedAt: new Date(now).toISOString(),
      }
    })
  }

  async resolveDocument({
    workspaceId,
    path,
  }: ResolveDocumentInput): Promise<DocumentEntry | null> {
    const row = await this.db
      .selectFrom('documents')
      .select(['id', 'path', 'kind', 'displayName', 'updatedAt'])
      .where('workspaceId', '=', workspaceId)
      .where('path', '=', path)
      .executeTakeFirst()
    if (!row) return null
    return toEntry(row)
  }

  async resolveDocumentById({
    workspaceId,
    documentId,
  }: ResolveDocumentByIdInput): Promise<DocumentEntry | null> {
    const row = await this.db
      .selectFrom('documents')
      .select(['id', 'path', 'kind', 'displayName', 'updatedAt'])
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', documentId)
      .executeTakeFirst()
    if (!row) return null
    return toEntry(row)
  }

  async setDocumentName({ workspaceId, documentId, name }: SetDocumentNameInput): Promise<void> {
    const result = await this.db
      .updateTable('documents')
      .set({ displayName: name ?? null })
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', documentId)
      .executeTakeFirst()
    if (result.numUpdatedRows === 0n) {
      throw new DocumentNotFoundError(workspaceId, documentId)
    }
  }

  async listDocuments({ workspaceId }: ListDocumentsInput): Promise<DocumentEntry[]> {
    const workspace = await this.db
      .selectFrom('workspaces')
      .select('id')
      .where('id', '=', workspaceId)
      .executeTakeFirst()
    if (!workspace) {
      throw new WorkspaceNotFoundError(workspaceId)
    }
    const rows = await this.db
      .selectFrom('documents')
      .select(['id', 'path', 'kind', 'displayName', 'updatedAt'])
      .where('workspaceId', '=', workspaceId)
      .execute()
    // Sorted here rather than in SQL: segment-wise order is not what any
    // collation gives, and the row count per workspace is a list a human reads.
    //
    // Rows whose id is not a canonical ULID are SKIPPED, not surfaced: the
    // port's DocumentEntry accepts only a ULID, so mapping such a row does
    // not degrade to one bad entry — it fails output validation for the
    // ENTIRE listing, and one bad row per workspace would turn the whole
    // agent surface dark. Every minting site converged on ULID (see the class
    // doc comment), so reaching this branch means one of those guarantees
    // broke — an ERROR, not the anticipated-legacy warning this used to log.
    const entries: DocumentEntry[] = []
    for (const row of rows) {
      if (!documentIdSchema.safeParse(row.id).success) {
        log.error(
          { workspaceId, path: row.path },
          'documents row has a non-ULID id — corruption, not expected legacy data; excluded from this listing',
        )
        continue
      }
      entries.push(toEntry(row))
    }
    return entries.sort((left, right) => compareDocumentPaths(left.path, right.path))
  }

  async moveDocument({ workspaceId, from, to }: MoveDocumentInput): Promise<void> {
    if (isSelfOrDescendant(to, from)) {
      throw new DocumentMoveIntoSelfError(from, to)
    }
    await withWorkspaceWriteLock(workspaceId, async () => {
      let moved: readonly { readonly from: string; readonly path: string }[] = []
      await this.db.transaction().execute(async (trx) => {
        const rows = await trx
          .selectFrom('documents')
          .select(['id', 'path'])
          .where('workspaceId', '=', workspaceId)
          .execute()

        const plan = planSubtreeMove(rows, from, to)
        if (!plan.ok) {
          throw plan.reason === 'not-found'
            ? new DocumentNotFoundError(workspaceId, from)
            : new DocumentPathTakenError(workspaceId, plan.path)
        }

        const now = Date.now()
        for (const move of plan.moves) {
          await trx
            .updateTable('documents')
            .set({ path: move.path, updatedAt: now })
            .where('id', '=', move.id)
            .execute()
        }
        moved = plan.moves
      })

      // After the commit, and still under the workspace lock: the cache is
      // keyed by (workspaceId, path), so every path this move touched now
      // holds a doc filed under a name that no longer means what it did.
      //
      // Both halves matter, and the destination half is the one that
      // corrupts rather than merely staling. A source path: a reader still
      // going through it must lazily create a fresh document rather than
      // resurrect the moved one. A destination path: `getDoc` creates an
      // empty doc for any path with no row yet, so a read that arrived
      // before this move left a phantom cached there — leaving it would
      // shadow the moved document's real content, and the next write through
      // it would persist the phantom over the top. Both apply to every
      // descendant, not only the two paths the caller named.
      for (const move of moved) {
        evictDoc(workspaceId, move.from)
        evictDoc(workspaceId, move.path)
      }
    })
  }

  async deleteDocument({ workspaceId, path }: DeleteDocumentInput): Promise<void> {
    await withWorkspaceWriteLock(workspaceId, () => deleteDocumentRow(this.db, workspaceId, path))
  }
}
