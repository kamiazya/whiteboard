import type {
  CreateDocumentInput,
  DeleteDocumentInput,
  DocumentEntry,
  DocumentIndex,
  ListDocumentsInput,
  MoveDocumentInput,
  ResolveDocumentInput,
} from '@kamiazya/whiteboard-canvas-ports'
import {
  compareDocumentPaths,
  DocumentHasDescendantsError,
  DocumentMoveIntoSelfError,
  DocumentNotFoundError,
  DocumentPathTakenError,
} from '@kamiazya/whiteboard-canvas-ports'
import { generateCanvasId } from '@kamiazya/whiteboard-server-core'
import type { Database } from './db/index.js'
import { upsertWorkspaceRow } from './db/upsert-workspace.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

/** Whether `path` is `ancestor` itself or sits below it. */
function isSelfOrDescendant(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`)
}

/**
 * `DocumentIndex` over the daemon's `canvases` table — the store the user's
 * canvas list, versions, branches and file GC already hang off, which is what
 * makes an agent-created document one a user can see.
 *
 * New rows are assigned a ULID, not the nanoid `saveCanvas` mints for its own
 * rows: ADR-0007 point 5 fixed the ULID as the `canvasId` and the nanoid as a
 * storage detail, and `canvasIdSchema` in the port's `DocumentEntry` accepts
 * only the former. A row predating this therefore does not round-trip through
 * the port, which is a deliberate consequence of converging the two id spaces
 * rather than an oversight.
 */
export class SqliteDocumentIndex implements DocumentIndex {
  constructor(private readonly db: Database) {}

  async createDocument({ workspaceId, path, kind }: CreateDocumentInput): Promise<DocumentEntry> {
    return withWorkspaceWriteLock(workspaceId, async () => {
      await upsertWorkspaceRow(this.db, workspaceId)
      const canvasId = generateCanvasId()
      const now = Date.now()
      // One statement, so the check and the claim cannot be separated: the
      // unique (workspaceId, slug) index decides, and a loser inserts nothing.
      const inserted = await this.db
        .insertInto('canvases')
        .values({
          id: canvasId,
          workspaceId,
          slug: path,
          displayName: null,
          isPinned: 0,
          pinOrder: null,
          currentBranch: 'main',
          createdAt: now,
          updatedAt: now,
          kind,
        })
        .onConflict((oc) => oc.columns(['workspaceId', 'slug']).doNothing())
        .executeTakeFirst()

      if ((inserted.numInsertedOrUpdatedRows ?? 0n) === 0n) {
        throw new DocumentPathTakenError(workspaceId, path)
      }
      return { canvasId, path, kind }
    })
  }

  async resolveDocument({
    workspaceId,
    path,
  }: ResolveDocumentInput): Promise<DocumentEntry | null> {
    const row = await this.db
      .selectFrom('canvases')
      .select(['id', 'slug', 'kind'])
      .where('workspaceId', '=', workspaceId)
      .where('slug', '=', path)
      .executeTakeFirst()
    if (!row?.kind) return null
    return { canvasId: row.id, path: row.slug, kind: row.kind }
  }

  async listDocuments({ workspaceId }: ListDocumentsInput): Promise<DocumentEntry[]> {
    const rows = await this.db
      .selectFrom('canvases')
      .select(['id', 'slug', 'kind'])
      .where('workspaceId', '=', workspaceId)
      .execute()
    // Sorted here rather than in SQL: segment-wise order is not what any
    // collation gives, and the row count per workspace is a list a human reads.
    return rows
      .filter((row) => row.kind !== null)
      .map((row) => ({ canvasId: row.id, path: row.slug, kind: row.kind as DocumentEntry['kind'] }))
      .sort((left, right) => compareDocumentPaths(left.path, right.path))
  }

  async moveDocument({ workspaceId, from, to }: MoveDocumentInput): Promise<void> {
    if (isSelfOrDescendant(to, from)) {
      throw new DocumentMoveIntoSelfError(from, to)
    }
    await withWorkspaceWriteLock(workspaceId, async () => {
      await this.db.transaction().execute(async (trx) => {
        const rows = await trx
          .selectFrom('canvases')
          .select(['id', 'slug'])
          .where('workspaceId', '=', workspaceId)
          .execute()

        const moving = rows.filter((row) => isSelfOrDescendant(row.slug, from))
        if (moving.length === 0) {
          throw new DocumentNotFoundError(workspaceId, from)
        }
        const occupied = new Set(rows.map((row) => row.slug))
        const rewritten = moving.map((row) => ({
          id: row.id,
          from: row.slug,
          slug: `${to}${row.slug.slice(from.length)}`,
        }))
        // Every produced path, not just `to`: moving `a` onto a free `c`
        // still collides when `a/d` and `c/d` both exist. Paths the move is
        // vacating do not count as occupied, or relocating a subtree would
        // always collide with itself.
        const vacating = new Set(moving.map((row) => row.slug))
        for (const row of rewritten) {
          if (occupied.has(row.slug) && !vacating.has(row.slug)) {
            throw new DocumentPathTakenError(workspaceId, row.slug)
          }
        }

        // Shallowest source first. When a move goes UP into its own ancestor
        // namespace the produced path of a deeper row equals the vacated path
        // of a shallower one, so writing them in the order the query happened
        // to return can hit the unique index on a move the contract says
        // succeeds. `compareDocumentPaths` already sorts a parent before its
        // descendants, which is exactly the order that frees each path before
        // anything claims it.
        rewritten.sort((left, right) => compareDocumentPaths(left.from, right.from))

        const now = Date.now()
        for (const row of rewritten) {
          await trx
            .updateTable('canvases')
            .set({ slug: row.slug, updatedAt: now })
            .where('id', '=', row.id)
            .execute()
        }
      })
    })
  }

  async deleteDocument({ workspaceId, path }: DeleteDocumentInput): Promise<void> {
    await withWorkspaceWriteLock(workspaceId, async () => {
      const descendant = await this.db
        .selectFrom('canvases')
        .select('slug')
        .where('workspaceId', '=', workspaceId)
        .where('slug', 'like', `${path}/%`)
        .executeTakeFirst()
      if (descendant) {
        throw new DocumentHasDescendantsError(
          path,
          `Delete "${descendant.slug}" and any others below it first.`,
        )
      }
      await this.db
        .deleteFrom('canvases')
        .where('workspaceId', '=', workspaceId)
        .where('slug', '=', path)
        .execute()
    })
  }
}
