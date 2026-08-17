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
  DocumentHasDescendantsError,
  DocumentMoveIntoSelfError,
  DocumentNotFoundError,
  DocumentPathTakenError,
  WorkspaceNotFoundError,
} from '@kamiazya/whiteboard-ports'
import { getLogger } from '../log.js'
import type { Database } from './db/index.js'
import { upsertWorkspaceRow } from './db/upsert-workspace.js'
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
}): DocumentEntry {
  return {
    documentId: row.id,
    path: row.path,
    ...(row.kind === null ? {} : { kind: row.kind as DocumentEntry['kind'] }),
    ...(row.displayName === null ? {} : { name: row.displayName }),
  }
}

/** How many segments a path has. */
function depth(path: string): number {
  return path.split('/').length
}

/** Whether `path` is `ancestor` itself or sits below it. */
function isSelfOrDescendant(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`)
}

/**
 * `DocumentIndex` over the daemon's `canvases` table — the store the user's
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
      return { documentId, path, kind, ...(name === undefined ? {} : { name }) }
    })
  }

  async resolveDocument({
    workspaceId,
    path,
  }: ResolveDocumentInput): Promise<DocumentEntry | null> {
    const row = await this.db
      .selectFrom('documents')
      .select(['id', 'path', 'kind', 'displayName'])
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
      .select(['id', 'path', 'kind', 'displayName'])
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
      .select(['id', 'path', 'kind', 'displayName'])
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
      await this.db.transaction().execute(async (trx) => {
        const rows = await trx
          .selectFrom('documents')
          .select(['id', 'path'])
          .where('workspaceId', '=', workspaceId)
          .execute()

        const moving = rows.filter((row) => isSelfOrDescendant(row.path, from))
        if (moving.length === 0) {
          throw new DocumentNotFoundError(workspaceId, from)
        }
        const occupied = new Set(rows.map((row) => row.path))
        const rewritten = moving.map((row) => ({
          id: row.id,
          from: row.path,
          path: `${to}${row.path.slice(from.length)}`,
        }))
        // Every produced path, not just `to`: moving `a` onto a free `c`
        // still collides when `a/d` and `c/d` both exist. Paths the move is
        // vacating do not count as occupied, or relocating a subtree would
        // always collide with itself.
        const vacating = new Set(moving.map((row) => row.path))
        for (const row of rewritten) {
          if (occupied.has(row.path) && !vacating.has(row.path)) {
            throw new DocumentPathTakenError(workspaceId, row.path)
          }
        }

        // Shallowest source first, by DEPTH — not by path order. A move up
        // into its own ancestor namespace sends a deeper row onto the path a
        // shallower one is vacating, so the shallower write has to land
        // first or the unique index rejects a move the contract requires to
        // succeed. The two contending rows need not be ancestor and
        // descendant of each other (`a/b/x` and `a/b/b/x` both branch below
        // `a/b`), which is why segment-wise path order is not enough here: it
        // would put `a/b/b/x` first because `b` precedes `x`. Only the depth
        // difference is guaranteed, and it is: the row producing a contested
        // path is always deeper than the row vacating it, by exactly the
        // number of segments the move removes.
        rewritten.sort((left, right) => depth(left.from) - depth(right.from))

        const now = Date.now()
        for (const row of rewritten) {
          await trx
            .updateTable('documents')
            .set({ path: row.path, updatedAt: now })
            .where('id', '=', row.id)
            .execute()
        }
      })
    })
  }

  async deleteDocument({ workspaceId, path }: DeleteDocumentInput): Promise<void> {
    await withWorkspaceWriteLock(workspaceId, async () => {
      const descendant = await this.db
        .selectFrom('documents')
        .select('path')
        .where('workspaceId', '=', workspaceId)
        .where('path', 'like', `${path}/%`)
        .executeTakeFirst()
      if (descendant) {
        throw new DocumentHasDescendantsError(
          path,
          `Delete "${descendant.path}" and any others below it first.`,
        )
      }
      await this.db
        .deleteFrom('documents')
        .where('workspaceId', '=', workspaceId)
        .where('path', '=', path)
        .execute()
    })
  }
}
