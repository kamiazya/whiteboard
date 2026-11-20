import {
  autoVersionsOverCap,
  carriedAutoVersionsOverCap,
  frontiersFromBase64,
  frontiersToBase64,
  MAX_AUTO_PER_DOCUMENT,
  sandwichedAutoVersionIds,
} from '@kamiazya/whiteboard-history'
import {
  type RecordSession,
  type RecordView,
  sharedCrdtEngine,
} from '@kamiazya/whiteboard-loro-adapter'
import { DocumentNotFoundError } from '@kamiazya/whiteboard-ports'
import type { Insertable } from 'kysely'
import { sql } from 'kysely'
import { nanoid } from 'nanoid'
import { getLogger } from '../log.js'
import { validateDocumentPath, validateVersionId, validateWorkspaceId } from '../validators.js'
import { corruptStoredData } from './corrupt-stored-data.js'
import type { DatabaseSchema } from './db/schema.js'
import { globalStoreScope, type StoreScope } from './store-scope.js'
import { insertAdoptedRows } from './version-adopt-rows.js'
import { refusePastManualCeiling, refusePastRestorePointCeiling } from './version-ceilings.js'
import { withPersistedWorkspaceRecord, withStoredWorkspaceRecord } from './workspace-doc-cache.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

const log = getLogger('version-store')

// Loro-native versioning, backed by the sqlite metadata DB.
//
// Storage:
//   versions table        -> per-version metadata + base64 frontiers
//
// load() forks the cached workspace record, checks out the saved frontiers,
// and returns an independent past-state doc without touching the live cache
// entry. CRDT history cannot be forgotten, so route-level restore writes
// reverse ops on top of the live doc rather than overwriting it.
//
// Every read here goes through the CACHED record (workspace-doc-cache.ts),
// which is caught up with the stored one on access. A record holds every
// document of the workspace, so decoding it per call costs the workspace —
// and the callers come in batches: one checkpoint per edited document, one
// load per version a file-GC pass walks.

// z.infer of the shared wire schema, not a hand-written twin: a separately
// written interface beside a Zod schema is the drift recipe the Zod
// discipline names, and this pair had three copies of one shape.
import {
  type ListVersionsRequest,
  type ListVersionsResponse,
  type OperatorInfo,
  VERSIONS_PAGE_MAX,
  type VersionEntry,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { messageOf } from '@kamiazya/whiteboard-model'
import {
  type AdoptedVersion,
  type Attestation,
  attestationSchema,
  type VersionHistory,
} from '@kamiazya/whiteboard-server-core'

export type { OperatorInfo, VersionEntry }

// What the keeper adds to the `VersionHistory` seam server-core owns: save,
// load, loadWorkspaceAt and list are that seam's, documented there.
export interface VersionStore extends VersionHistory {
  // `list` answers a mutable array, which narrows the seam's readonly one.
  list(workspaceId: string, path: string): Promise<VersionEntry[]>
  // The ids of every saved version of one document, addressed by its id
  // rather than a path: a trashed document has no path, and a shadowed one's
  // path resolves to another document, yet both keep their versions — what
  // file collection must still walk.
  listIdsByDocument(workspaceId: string, documentId: string): Promise<string[]>
  /**
   * One bounded page of `list`, newest first, starting after `cursor` (a
   * previous page's `nextCursor`) or at the newest version, `limit` long or
   * `VERSIONS_PAGE_MAX` when it says nothing. What a route
   * answers, so a request costs its page rather than the whole history.
   */
  listPage(
    workspaceId: string,
    path: string,
    page: ListVersionsRequest,
  ): Promise<ListVersionsResponse>
  /**
   * Whether `versionId` is a version of the document at `path` — the
   * ownership a read by id must check, so an id alone cannot read another
   * document's history — without listing the history to find out.
   */
  belongsTo(workspaceId: string, path: string, versionId: string): Promise<boolean>
  /**
   * The frontiers of every version in the workspace — the points a version
   * checkout still needs from the workspace record's history, which is what
   * compaction's cut must lie before (`compactionCut`). Empty when the
   * workspace has no versions.
   */
  workspaceVersionFrontiers(workspaceId: string): Promise<StoredFrontiers[]>
  /**
   * One copy of the workspace record, checked out at each version asked for —
   * for a caller walking many versions, which would otherwise copy the whole
   * record once per version. A version naming the point the copy already
   * stands at costs no checkout.
   */
  openCheckouts(workspaceId: string): Promise<VersionCheckouts>
  // Does the newest checkpoint of this document already hold the state the
  // record is in? The scheduler asks the keeper rather than comparing
  // frontiers itself, because a version's frontier is taken in THIS store's
  // space (the workspace record's) and the doc a scheduler holds is the
  // document's own projection — compared across that boundary they are
  // never equal. False where there is no version yet, or no such document.
  isUnchangedSinceLastVersion(workspaceId: string, path: string): Promise<boolean>
  // Drop auto-saved versions strictly between two manual versions of the
  // document. Manual versions are explicit user save-points so sandwiched
  // autos add no rollback value beyond what the bracketing manuals
  // already give. Autos before the first manual or after the last manual
  // stay (they are the only rollback target outside the bracketed range).
  pruneSandwichedAutoVersions(
    workspaceId: string,
    path: string,
  ): Promise<{ deletedCount: number; deletedIds: string[] }>
}

/** See `VersionStore.openCheckouts`. */
export interface VersionCheckouts {
  /** What `VersionStore.load` answers, read off the shared copy. */
  load(versionId: string): Promise<Uint8Array | null>
  /** Gives the shared copy back; call it once the walk is done. */
  release(): void
}

/** The same points loro-crdt's `Frontiers` names, spelled without importing it. */
export type StoredFrontiers = Array<{ peer: `${number}`; counter: number }>

/**
 * The engine's answers are the shapes the loro-adapter readers return; this
 * store asserts the type and holds no schema of its own for it.
 */
const assertedAs = <T>() => ({ parse: (value: unknown) => value as T })

interface PathEntry {
  documentId: string
  contentDigest: string
}

const entryAtPath = (record: RecordSession, path: string) =>
  record.read({ query: 'workspaceDocumentEntry', args: { path } }, assertedAs<PathEntry | null>())

interface VersionRow {
  id: string
  documentId: string
  auto: number
  label: string | null
  // '' means the row records no operator at all. It has to be spelled on
  // the KIND because the actor is optional: an empty actor would carry both
  // meanings ("nobody saved this" and "we do not know who"), and a keeper
  // without an identity can legally name a kind and no actor.
  operatorKind: '' | 'ai' | 'human' | 'system'
  operatorActor: string
  operatorDisplayName: string | null
  operatorAgentId: string | null
  operatorWorkspaceId: string | null
  elementCount: number
  frontiers: string
  // See db/schema.ts: '' means this row predates the digest.
  contentDigest: string
  createdAt: number
  restoredFrom: string | null
  // JSON of `attestationSchema`; see db/schema.ts.
  attestation: string | null
  // The store hydrates this from the documents row at list time so callers
  // still see a path field on each entry.
  path: string
}

function rowToEntry(row: VersionRow): VersionEntry {
  const attestation = parseStoredAttestation(row)
  const operator: OperatorInfo | undefined =
    row.operatorKind !== ''
      ? {
          kind: row.operatorKind,
          ...(row.operatorActor.length > 0 ? { actor: row.operatorActor } : {}),
          ...(row.operatorDisplayName !== null ? { displayName: row.operatorDisplayName } : {}),
          ...(row.operatorAgentId !== null ? { agentId: row.operatorAgentId } : {}),
          ...(row.operatorWorkspaceId !== null ? { workspaceId: row.operatorWorkspaceId } : {}),
        }
      : undefined
  return {
    id: row.id,
    path: row.path,
    createdAt: new Date(row.createdAt).toISOString(),
    elementCount: row.elementCount,
    auto: row.auto === 1,
    ...(row.label !== null ? { label: row.label } : {}),
    ...(operator !== undefined ? { operator } : {}),
    ...(row.restoredFrom !== null ? { restoredFrom: row.restoredFrom } : {}),
    ...(attestation !== undefined ? { attestation } : {}),
  }
}

/**
 * A stored attestation that fails its own schema reads as no attestation
 * rather than as a corrupt row: the row's other columns are still a valid
 * checkpoint, and the badge it loses is the honest one for evidence nobody
 * can re-verify. Logged, so the loss is visible rather than silent.
 */
function parseStoredAttestation(
  row: Pick<VersionRow, 'id' | 'attestation'>,
): Attestation | undefined {
  if (row.attestation === null) return undefined
  try {
    return attestationSchema.parse(JSON.parse(row.attestation))
  } catch (err) {
    log.warning({ versionId: row.id, err }, 'version row carries an unreadable attestation')
    return undefined
  }
}

/** What `save` takes beyond the document itself. */
type SaveVersionOpts = Parameters<FileVersionStore['save']>[2]

/**
 * The row a saved version becomes. Every optional field is written as NULL
 * rather than omitted, because the column exists either way.
 */
function versionRow({
  id,
  documentId,
  workspaceId,
  opts,
  operator,
  elementCount,
  frontiers,
  contentDigest,
  createdAt,
}: {
  id: string
  documentId: string
  workspaceId: string
  opts: SaveVersionOpts
  operator: SaveVersionOpts['operator']
  elementCount: number
  frontiers: string
  contentDigest: string
  createdAt: number
}): Insertable<DatabaseSchema['versions']> {
  return {
    id,
    documentId,
    workspaceId,
    auto: opts.auto ? 1 : 0,
    label: opts.label ?? null,
    operatorKind: operator?.kind ?? '',
    operatorActor: operator?.actor ?? '',
    operatorDisplayName: operator?.displayName ?? null,
    operatorAgentId: operator?.agentId ?? null,
    operatorWorkspaceId: operator?.workspaceId ?? null,
    elementCount,
    frontiers,
    contentDigest,
    createdAt,
    restoredFrom: opts.restoredFrom ?? null,
    // Nothing saves a version with a person's evidence; the column is kept
    // for the rows that already carry one, which `rowToEntry` still reads.
    attestation: null,
  }
}

/**
 * What the caller is told it saved. Spread-or-nothing on every optional
 * field, so a version with no label carries no `label` key at all rather
 * than an explicit `undefined` — the published shape says absent, and a row
 * that is compared or spread would see the difference.
 */
function savedVersion({
  id,
  path,
  createdAt,
  elementCount,
  operator,
  opts,
}: {
  id: string
  path: string
  createdAt: number
  elementCount: number
  operator: SaveVersionOpts['operator']
  opts: SaveVersionOpts
}): VersionEntry {
  return {
    id,
    path,
    createdAt: new Date(createdAt).toISOString(),
    elementCount,
    auto: opts.auto,
    ...(opts.label !== undefined ? { label: opts.label } : {}),
    ...(operator !== undefined ? { operator } : {}),
    ...(opts.restoredFrom !== undefined ? { restoredFrom: opts.restoredFrom } : {}),
  }
}

export class FileVersionStore implements VersionStore {
  /**
   * `scope` is which data directory these versions live in. Omitted, it
   * follows the process's — what a router that was handed no composition
   * uses; a composition builds its own over the directory it serves.
   */
  constructor(private readonly scope: StoreScope = globalStoreScope) {}

  async save(
    workspaceId: string,
    path: string,
    opts: {
      auto: boolean
      label?: string
      operator?: OperatorInfo
      /** The version this point was produced by restoring; see `versionEntrySchema`. */
      restoredFrom?: string
    },
  ): Promise<VersionEntry> {
    validateWorkspaceId(workspaceId)
    validateDocumentPath(path)
    // Hold the per-workspace write barrier so a concurrent
    // purgeDanglingFiles cannot interleave with the version row being
    // created. The references this save records are a subset of what
    // GC already inspected, but pairing both writers behind the same
    // queue keeps the lock contract uniform — all "things that might
    // change what GC considers referenced" run serially.
    return withWorkspaceWriteLock(workspaceId, async () => {
      const id = nanoid(12)
      validateVersionId(id)

      const createdAt = Date.now()
      const operator = opts.operator

      const db = await this.scope.db()
      // A document's checkpoint lives in the WORKSPACE document's oplog:
      // that lineage is durable across restarts, while a projection's is
      // reborn per process — frontiers recorded against it would break on
      // the first daemon restart. The record must hold only persisted ops,
      // because that is what the frontier will point at — and it is also the
      // address book: the path resolves in the tree.
      const { documentId, elementCount, frontiers, contentDigest } =
        await withPersistedWorkspaceRecord(workspaceId, this.scope, async (record) => {
          const entry = record === null ? null : await entryAtPath(record, path)
          if (record === null || entry === null) throw new DocumentNotFoundError(workspaceId, path)
          // Counted off the record the frontier below names, so the row says
          // how many nodes the state it points at holds.
          const elementCount = await record.read(
            { query: 'spatialNodeCount', args: { documentId: entry.documentId } },
            assertedAs<number>(),
          )
          return {
            documentId: entry.documentId,
            elementCount,
            frontiers: frontiersToBase64(record.version().encodedFrontiers),
            // Free: `entry` is the resolve this save already did, and the
            // digest is derived on that same read of the tree node.
            contentDigest: entry.contentDigest,
          }
        })
      if (!opts.auto) await refusePastManualCeiling(db, workspaceId, documentId)
      if (opts.restoredFrom !== undefined) {
        await refusePastRestorePointCeiling(db, workspaceId, documentId)
      }
      await db
        .insertInto('versions')
        .values(
          versionRow({
            id,
            documentId,
            workspaceId,
            opts,
            operator,
            elementCount,
            frontiers,
            contentDigest,
            createdAt,
          }),
        )
        .execute()

      await this.prune(workspaceId, documentId)

      return savedVersion({ id, path, createdAt, elementCount, operator, opts })
    })
  }

  /**
   * The rows go in under the ids the other keeper gave them, so a re-run of
   * the same move inserts nothing, and a `restoredFrom` still names its row.
   * An id another workspace already holds is not taken over: that row stays
   * the other workspace's, and the answer — read back for THIS workspace —
   * leaves the id out, which is how the caller learns the history did not
   * arrive whole.
   *
   * The answer is read back BEFORE the automatic cap prunes: a carried
   * automatic row the cap then retires did reach this keeper. The cap makes
   * room from the carried rows alone, never from this keeper's own: a carried
   * date is the other keeper's claim. Read after, a re-run once this keeper had taken
   * a checkpoint of its own reported that row as never arriving — and the
   * caller, keeping its copy for it, re-sent it on every retry to the same end.
   */
  async adopt(workspaceId: string, rows: readonly AdoptedVersion[]): Promise<string[]> {
    validateWorkspaceId(workspaceId)
    for (const row of rows) validateVersionId(row.id)
    if (rows.length === 0) return []
    return withWorkspaceWriteLock(workspaceId, async () => {
      const db = await this.scope.db()
      const { inserted, held } = await insertAdoptedRows(
        db,
        workspaceId,
        rows.map((row) =>
          versionRow({
            id: row.id,
            documentId: row.documentId,
            workspaceId,
            opts: row,
            operator: row.operator,
            elementCount: row.elementCount,
            frontiers: frontiersToBase64(row.frontiers),
            contentDigest: row.contentDigest,
            createdAt: row.createdAt,
          }),
        ),
      )
      const carried = new Set(inserted)
      for (const documentId of new Set(rows.map((row) => row.documentId))) {
        await this.prune(workspaceId, documentId, carried)
      }
      return held
    })
  }

  async load(workspaceId: string, id: string): Promise<Uint8Array | null> {
    validateWorkspaceId(workspaceId)
    validateVersionId(id)
    const checkouts = await this.openCheckouts(workspaceId)
    try {
      return await checkouts.load(id)
    } finally {
      checkouts.release()
    }
  }

  async openCheckouts(workspaceId: string): Promise<VersionCheckouts> {
    validateWorkspaceId(workspaceId)
    const db = await this.scope.db()
    // Opened on the first version that needs it, so a walk over a document
    // with no versions copies nothing; one copy of the record then stands for
    // the whole walk and is moved from version to version.
    let view: RecordView | null = null
    let standsAt: string | null = null
    return {
      load: async (id) => {
        validateVersionId(id)
        const row = await db
          .selectFrom('versions')
          .select(['frontiers', 'documentId'])
          .where('workspaceId', '=', workspaceId)
          .where('id', '=', id)
          .executeTakeFirst()
        if (!row) return null
        // Checked out against the WORKSPACE record, whose oplog the frontiers
        // were recorded in — never against a live per-document projection,
        // whose fresh lineage does not contain them. The past state is then
        // projected back out as a standalone document, which is the shape every
        // caller expects; the projection copies, so the next move of the
        // shared copy cannot reach it.
        if (view === null) {
          view = await this.viewAtVersion(workspaceId, id, row.frontiers, () => {
            throw corruptStoredData(
              `versions/${id}`,
              'workspace-scoped version has no stored workspace document to check out against',
            )
          })
          standsAt = row.frontiers
        } else if (standsAt !== row.frontiers) {
          const open = view
          checkedOut(id, () => open.moveTo(frontiersFromBase64(row.frontiers)))
          standsAt = row.frontiers
        }
        return view.exportProjection(row.documentId)
      },
      release() {
        view?.release()
        view = null
      },
    }
  }

  async loadWorkspaceAt(workspaceId: string, id: string): Promise<RecordView | null> {
    validateWorkspaceId(workspaceId)
    validateVersionId(id)
    const db = await this.scope.db()
    const row = await db
      .selectFrom('versions')
      .select(['frontiers'])
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) return null
    return this.viewAtVersion(workspaceId, id, row.frontiers, () => null)
  }

  /** A view of the stored record at a version's point; frontiers it cannot reach are corruption. */
  private viewAtVersion<T extends null | never>(
    workspaceId: string,
    versionId: string,
    frontiers: string,
    noRecord: () => T,
  ): Promise<RecordView | T> {
    return withStoredWorkspaceRecord(workspaceId, this.scope, async (record) =>
      record === null
        ? noRecord()
        : checkedOut(versionId, () => record.view(frontiersFromBase64(frontiers))),
    )
  }

  async list(workspaceId: string, path: string): Promise<VersionEntry[]> {
    validateWorkspaceId(workspaceId)
    validateDocumentPath(path)
    const db = await this.scope.db()
    const documentId = await this.resolveDocumentId(workspaceId, path)
    if (!documentId) return []
    const rows = await db
      .selectFrom('versions')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('documentId', '=', documentId)
      .orderBy('createdAt', 'desc')
      // Two saves in one millisecond share a createdAt, and the id is a
      // random nanoid, so ordering by it put "as drafted" after "after the
      // meeting" at random. The rowid is insertion order.
      .orderBy(sql`rowid`, 'desc')
      .execute()
    return rows.map((r) => rowToEntry({ ...r, path } as VersionRow))
  }

  async listIdsByDocument(workspaceId: string, documentId: string): Promise<string[]> {
    validateWorkspaceId(workspaceId)
    const db = await this.scope.db()
    const rows = await db
      .selectFrom('versions')
      .select(['id'])
      .where('workspaceId', '=', workspaceId)
      .where('documentId', '=', documentId)
      .orderBy('createdAt', 'desc')
      .orderBy(sql`rowid`, 'desc')
      .execute()
    return rows.map((row) => row.id)
  }

  async listPage(
    workspaceId: string,
    path: string,
    page: ListVersionsRequest,
  ): Promise<ListVersionsResponse> {
    validateWorkspaceId(workspaceId)
    validateDocumentPath(path)
    const documentId = await this.resolveDocumentId(workspaceId, path)
    if (!documentId) return { versions: [] }
    const after = page.cursor === undefined ? null : parseCursor(page.cursor)
    const limit = page.limit ?? VERSIONS_PAGE_MAX
    const db = await this.scope.db()
    let query = db
      .selectFrom('versions')
      .selectAll()
      .select(sql<number>`rowid`.as('seq'))
      .where('workspaceId', '=', workspaceId)
      .where('documentId', '=', documentId)
    if (after !== null) {
      // The list's own order, as a keyset: older by save time, or saved in
      // the same millisecond and inserted earlier.
      query = query.where((eb) =>
        eb.or([
          eb('createdAt', '<', after.createdAt),
          eb.and([eb('createdAt', '=', after.createdAt), eb(sql`rowid`, '<', after.seq)]),
        ]),
      )
    }
    // One row past the page says whether another page exists.
    const rows = await query
      .orderBy('createdAt', 'desc')
      .orderBy(sql`rowid`, 'desc')
      .limit(limit + 1)
      .execute()
    const shown = rows.slice(0, limit)
    const last = shown.at(-1)
    return {
      versions: shown.map(({ seq: _seq, ...r }) => rowToEntry({ ...r, path } as VersionRow)),
      ...(rows.length > limit && last !== undefined
        ? { nextCursor: `${last.createdAt}.${last.seq}` }
        : {}),
    }
  }

  async belongsTo(workspaceId: string, path: string, versionId: string): Promise<boolean> {
    validateWorkspaceId(workspaceId)
    validateDocumentPath(path)
    const documentId = await this.resolveDocumentId(workspaceId, path)
    if (!documentId) return false
    const db = await this.scope.db()
    const row = await db
      .selectFrom('versions')
      .select(['id'])
      .where('workspaceId', '=', workspaceId)
      .where('documentId', '=', documentId)
      .where('id', '=', versionId)
      .executeTakeFirst()
    return row !== undefined
  }

  async pruneSandwichedAutoVersions(
    workspaceId: string,
    path: string,
  ): Promise<{ deletedCount: number; deletedIds: string[] }> {
    validateWorkspaceId(workspaceId)
    validateDocumentPath(path)
    const db = await this.scope.db()
    const documentId = await this.resolveDocumentId(workspaceId, path)
    if (!documentId) return { deletedCount: 0, deletedIds: [] }
    const rows = await db
      .selectFrom('versions')
      .select(['id', 'auto', 'restoredFrom'])
      .where('workspaceId', '=', workspaceId)
      .where('documentId', '=', documentId)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .execute()

    // Which rows go is the mechanic's call (@kamiazya/whiteboard-history);
    // the rows and the delete are this store's.
    const toDelete = sandwichedAutoVersionIds(
      rows.map((row) => ({ id: row.id, auto: row.auto === 1, restoredFrom: row.restoredFrom })),
    )
    if (toDelete.length === 0) return { deletedCount: 0, deletedIds: [] }
    await db
      .deleteFrom('versions')
      .where('workspaceId', '=', workspaceId)
      .where('documentId', '=', documentId)
      .where('id', 'in', toDelete)
      .execute()
    return { deletedCount: toDelete.length, deletedIds: toDelete }
  }

  /**
   * Answered on the document's CONTENT, because the question is about one
   * document and a workspace-scoped frontier cannot be.
   *
   * Every document in a workspace lives in one record, so its frontier moves
   * on any of them — five edits to a sibling produced five "changed" answers
   * for a document nothing had touched. This is not a stray checkpoint here
   * and there: on a workspace anybody is working in, the scheduler could not
   * distinguish an untouched document from an edited one at all.
   *
   * The digest is a function of the MERGED content (`contentDigestOf`), not
   * of a write stamp, so two replicas that converged agree on it — which is
   * what makes it comparable across the boundary a frontier could not cross.
   * Both halves stay in this store's own space: the digest is derived from
   * the same tree node `save` derived the row's from.
   *
   * There is no second path for a row carrying no digest, because 0026 left
   * none: every row written before the column went rather than being carried.
   * None could be backfilled, and each would otherwise have kept the old,
   * wrong comparison alive to answer it.
   */
  async isUnchangedSinceLastVersion(workspaceId: string, path: string): Promise<boolean> {
    validateWorkspaceId(workspaceId)
    validateDocumentPath(path)
    const db = await this.scope.db()
    const entry = await withStoredWorkspaceRecord(workspaceId, this.scope, async (record) =>
      record === null ? null : entryAtPath(record, path),
    )
    if (entry === null) return false
    const row = await db
      .selectFrom('versions')
      .select(['contentDigest'])
      // Newest first, with the id as the tie-break the rest of this store
      // already orders by — two rows can share a millisecond.
      .where('workspaceId', '=', workspaceId)
      .where('documentId', '=', entry.documentId)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst()
    if (row === undefined) return false
    return row.contentDigest === entry.contentDigest
  }

  async workspaceVersionFrontiers(workspaceId: string): Promise<StoredFrontiers[]> {
    validateWorkspaceId(workspaceId)
    const db = await this.scope.db()
    const rows = await db
      .selectFrom('versions')
      .select(['id', 'frontiers'])
      .where('workspaceId', '=', workspaceId)
      .execute()
    if (rows.length === 0) return []
    const engine = await sharedCrdtEngine()
    return rows.map((row) => {
      try {
        // The engine's own decode of the stored bytes, entries as the points
        // `Frontiers` names; a text that is no frontier throws.
        const { entries } = engine.decode({ kind: 'frontiers', bytes: row.frontiers })
        return entries.map(({ peer, counter }) => ({ peer: peer as `${number}`, counter }))
      } catch (error) {
        throw corruptStoredData(
          `versions/${row.id}`,
          `frontiers could not be decoded (${messageOf(error)})`,
        )
      }
    })
  }

  /** The record is the address book: a path resolves in its tree. */
  private async resolveDocumentId(workspaceId: string, path: string): Promise<string | null> {
    return withStoredWorkspaceRecord(workspaceId, this.scope, async (record) =>
      record === null ? null : ((await entryAtPath(record, path))?.documentId ?? null),
    )
  }

  /**
   * The cap is per document WITHIN a workspace: a promote can land one
   * browser record in two daemon workspaces, so a document id is not unique
   * across them, and a cap counted across both would retire one workspace's
   * history for the other's activity. With `carried`, the rows an adopt just
   * inserted, only those may go: a carried row dated after this keeper's own
   * outranks them in the newest-first cap.
   */
  private async prune(
    workspaceId: string,
    documentId: string,
    carried?: ReadonlySet<string>,
  ): Promise<void> {
    const db = await this.scope.db()
    const autos = await db
      .selectFrom('versions')
      .select(['id', 'restoredFrom'])
      .where('workspaceId', '=', workspaceId)
      .where('documentId', '=', documentId)
      .where('auto', '=', 1)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .execute()
    if (autos.length <= MAX_AUTO_PER_DOCUMENT) return
    // Lineage outlives the cap — the mechanic's rule
    // (@kamiazya/whiteboard-history's `autoVersionsOverCap`); the referenced
    // set is what this store knows about its own rows.
    const referenced = new Set(
      (
        await db
          .selectFrom('versions')
          .select(['restoredFrom'])
          .where('workspaceId', '=', workspaceId)
          .where('documentId', '=', documentId)
          .where('restoredFrom', 'is not', null)
          .execute()
      ).flatMap((r) => (r.restoredFrom === null ? [] : [r.restoredFrom])),
    )
    const toRemove =
      carried === undefined
        ? autoVersionsOverCap(autos, referenced)
        : carriedAutoVersionsOverCap(autos, carried, referenced)
    if (toRemove.length === 0) return
    await db
      .deleteFrom('versions')
      .where('workspaceId', '=', workspaceId)
      .where('documentId', '=', documentId)
      .where('id', 'in', toRemove)
      .execute()
  }
}

/** Runs a move of a view to a saved point; one the record cannot reach is corruption. */
function checkedOut<T>(versionId: string, move: () => T): T {
  try {
    return move()
  } catch (error) {
    throw corruptStoredData(
      `versions/${versionId}`,
      `frontiers could not be checked out against the workspace document (${messageOf(error)})`,
    )
  }
}

/** A `versionsCursorSchema` cursor, as the keyset it names. */
function parseCursor(cursor: string): { createdAt: number; seq: number } {
  const [createdAt, seq] = cursor.split('.').map(Number)
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(seq)) {
    throw new RangeError(`not a versions cursor: ${cursor}`)
  }
  return { createdAt: createdAt as number, seq: seq as number }
}
