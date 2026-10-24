import { SINGLE_PERSON_NAMESPACE } from '@kamiazya/whiteboard-model'
import {
  type BlobStore,
  type CreateWorkspaceInput,
  createWorkspaceInputSchema,
  KeyedSerializer,
  NAMESPACE_MAX_WORKSPACES,
  type RenameWorkspaceInput,
  refuseNewWorkspace,
  renameWorkspaceInputSchema,
  type WorkspaceEntry,
} from '@kamiazya/whiteboard-ports'
import {
  LoroWorkspaceDocumentIndex,
  type WorkspaceDocs,
  type WorkspaceRegistry,
} from '@kamiazya/whiteboard-workspace-index'
import { checkpointAfterMove, checkpointAfterRemoval } from './auto-checkpoint.js'
import {
  inTenantTransaction,
  type TenantScoped,
  type TenantTransaction,
} from './db/tenant-database.js'
import { upsertWorkspaceRow } from './db/upsert-workspace.js'
import { evictDoc } from './doc-cache.js'
import { moveEvictingCache } from './moved-paths.js'
import { globalStoreScope, type StoreScope } from './store-scope.js'
import { trashBlobNamedElsewhere } from './trash-blob-named-elsewhere.js'
import { openWorkspaceDocIfStored } from './workspace-doc-cache.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

/** Creates in one namespace, one at a time per instance — see `createWorkspace`. */
const namespaceCreates = new KeyedSerializer()

async function refuseWorkspacePastCeiling(
  trx: TenantTransaction,
  workspaceId: string,
  namespace: string,
): Promise<void> {
  const held = await trx
    .selectFrom('workspaces')
    .select((eb) => eb.fn.countAll<number>().as('held'))
    .where('namespace', '=', namespace)
    .executeTakeFirstOrThrow()
  if (held.held < NAMESPACE_MAX_WORKSPACES) return
  const existing = await trx
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', workspaceId)
    .executeTakeFirst()
  if (existing === undefined) refuseNewWorkspace(namespace, Number(held.held))
}

/**
 * The tree index, with this composition root's doc-cache kept coherent
 * around the moves and deletes the port performs. The cache is keyed by
 * (workspaceId, path), so a path a document LEAVES keeps a doc filed under a
 * name that no longer means what it did, and is evicted here. A path a
 * document ARRIVES at needs nothing: the cache never holds an entry for a
 * path the tree places nothing at (`getOrLoad`), so there is no empty
 * stand-in for a restore, a duplicate or a create to displace. The shared
 * index cannot know this cache exists, so the composition root wraps it.
 *
 * The automatic-checkpoint scheduler's pending work is path-keyed state of the
 * same kind, so the same wrapper tells it.
 */
export class CacheCoherentDocumentIndex extends LoroWorkspaceDocumentIndex {
  /**
   * `scope` is the data directory the registry row and the doc-cache entries
   * belong to; `docs`, `blobs` and `registry` are expected to be over the same
   * one, which is why a composition builds all four from one scope.
   */
  constructor(
    docs: WorkspaceDocs,
    blobs: BlobStore,
    registry: WorkspaceRegistry,
    private readonly scope: StoreScope = globalStoreScope,
  ) {
    super(docs, blobs, registry, { trashBlobNamedElsewhere: trashBlobNamedElsewhere(scope) })
  }

  // Every mutator holds the workspace write lock, not only the two that
  // need cache eviction: the base class's own per-instance serialiser is a
  // DIFFERENT mutex from the one saveDocument/saveSnapshot hold, and two
  // disjoint mutexes over the same workspace record allow the lost-update
  // interleaving workspace-lock.ts's doc comment describes. Re-entrant, so
  // a caller already inside the lock (routes, teardown) is unaffected.
  /**
   * Validated at this boundary (createWorkspaceInputSchema.parse) BEFORE any
   * write, so a rejected segment/displayName leaves no half-created
   * workspace. The registry identity (segment/displayName) is claimed
   * FIRST, inside the write lock, ahead of the tree record `super` creates —
   * a refused segment must not leave a workspace with a tree record and no
   * registry row. `upsertWorkspaceRow` translates a segment collision into
   * `WorkspaceSegmentTakenError`; `super.createWorkspace`'s own bare
   * `upsertWorkspaceRow` call then no-ops on the `id` conflict, so it cannot
   * clobber what was just claimed.
   */
  override async createWorkspace(input: CreateWorkspaceInput): Promise<void> {
    const parsed = createWorkspaceInputSchema.parse(input)
    const namespace = parsed.namespace ?? SINGLE_PERSON_NAMESPACE
    if (namespace === SINGLE_PERSON_NAMESPACE) return this.#createWorkspace(parsed)
    // What holds the count exact is the transaction `#createWorkspace` counts
    // in; this queue only lines up one instance's creates in one namespace
    // in-process, rather than on the database's busy-retry.
    return namespaceCreates.run(`${this.scope.layout.tenantId}\0${namespace}`, () =>
      this.#createWorkspace(parsed, namespace),
    )
  }

  /**
   * `heldBy` is the namespace a server-mode create is held to the ceiling
   * in. Its count and the registry row are one transaction, which takes the
   * write lock as it begins (`BEGIN IMMEDIATE`, busy-retry.ts): a hand-over
   * into the same namespace counts in a transaction of its own
   * (`namespaceHasRoom`), so the two cannot both take its last place. A
   * create naming a workspace that already exists writes nothing new, so it
   * is not refused for a namespace that is full.
   */
  async #createWorkspace(parsed: CreateWorkspaceInput, heldBy?: string): Promise<void> {
    return withWorkspaceWriteLock(parsed.workspaceId, async () => {
      const db = await this.scope.db()
      const claim = (scoped: TenantScoped) =>
        upsertWorkspaceRow(scoped, parsed.workspaceId, {
          ...(parsed.namespace === undefined ? {} : { namespace: parsed.namespace }),
          ...(parsed.segment === undefined ? {} : { segment: parsed.segment }),
          ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
        })
      if (heldBy === undefined) await claim(db)
      else {
        await inTenantTransaction(db, async (trx) => {
          await refuseWorkspacePastCeiling(trx, parsed.workspaceId, heldBy)
          await claim(trx)
        })
      }
      await super.createWorkspace(parsed)
    })
  }

  /**
   * Under the same lock every other mutator holds. A rename writes only the
   * registry row, but `createWorkspace` writes that row too — and the two
   * running unserialised on one workspace is the interleaving the lock
   * exists for.
   */
  override async renameWorkspace(input: RenameWorkspaceInput): Promise<WorkspaceEntry> {
    const parsed = renameWorkspaceInputSchema.parse(input)
    return withWorkspaceWriteLock(parsed.workspaceId, () => super.renameWorkspace(parsed))
  }

  override async createDocument(
    input: Parameters<LoroWorkspaceDocumentIndex['createDocument']>[0],
  ): ReturnType<LoroWorkspaceDocumentIndex['createDocument']> {
    return withWorkspaceWriteLock(input.workspaceId, () => super.createDocument(input))
  }

  override async duplicateDocument(
    input: Parameters<LoroWorkspaceDocumentIndex['duplicateDocument']>[0],
  ): ReturnType<LoroWorkspaceDocumentIndex['duplicateDocument']> {
    return withWorkspaceWriteLock(input.workspaceId, () => super.duplicateDocument(input))
  }

  override async setDocumentName(
    input: Parameters<LoroWorkspaceDocumentIndex['setDocumentName']>[0],
  ): Promise<void> {
    return withWorkspaceWriteLock(input.workspaceId, () => super.setDocumentName(input))
  }

  override async setFolderName(
    input: Parameters<LoroWorkspaceDocumentIndex['setFolderName']>[0],
  ): Promise<void> {
    return withWorkspaceWriteLock(input.workspaceId, () => super.setFolderName(input))
  }

  override async setDocumentPinned(
    input: Parameters<LoroWorkspaceDocumentIndex['setDocumentPinned']>[0],
  ): Promise<void> {
    return withWorkspaceWriteLock(input.workspaceId, () => super.setDocumentPinned(input))
  }

  override async restoreDocument(
    input: Parameters<LoroWorkspaceDocumentIndex['restoreDocument']>[0],
  ): ReturnType<LoroWorkspaceDocumentIndex['restoreDocument']> {
    return withWorkspaceWriteLock(input.workspaceId, () => super.restoreDocument(input))
  }

  /**
   * Destroys a trashed document for good, saved versions included: the
   * delete kept them so a restore could rejoin them (`createDocumentTeardown`),
   * and after a purge nothing can.
   */
  override async purgeTrashEntry(
    input: Parameters<LoroWorkspaceDocumentIndex['purgeTrashEntry']>[0],
  ): ReturnType<LoroWorkspaceDocumentIndex['purgeTrashEntry']> {
    return withWorkspaceWriteLock(input.workspaceId, async () => {
      const purged = await super.purgeTrashEntry(input)
      if (purged) {
        const db = await this.scope.db()
        await db
          .deleteFrom('versions')
          .where('workspaceId', '=', input.workspaceId)
          .where('documentId', '=', input.documentId)
          .execute()
      }
      return purged
    })
  }

  override async moveDocument(input: {
    workspaceId: string
    from: string
    to: string
  }): Promise<void> {
    // Under the workspace write lock, like the retired SQL index's move: the
    // route flows (sync updates, live-doc saves) load-and-save inside this
    // lock, so a move outside it can land between an update's stalled read
    // and its write — the update then lazily recreates the source path and a
    // phantom duplicate survives the rename.
    return withWorkspaceWriteLock(input.workspaceId, async () => {
      const workspaceDoc = await openWorkspaceDocIfStored(input.workspaceId, this.scope)
      await moveEvictingCache(
        input.workspaceId,
        input.from,
        input.to,
        this.scope,
        workspaceDoc,
        () => super.moveDocument(input),
      )
      // A pending automatic checkpoint is keyed by path too, and the keeper
      // resolves that path when it saves: left under the old name it would
      // fail against a document that is no longer there.
      checkpointAfterMove(input.workspaceId, input.from, input.to)
    })
  }

  override async deleteDocument(input: { workspaceId: string; path: string }): Promise<void> {
    return withWorkspaceWriteLock(input.workspaceId, async () => {
      await super.deleteDocument(input)
      evictDoc(input.workspaceId, input.path, this.scope)
      checkpointAfterRemoval(input.workspaceId, input.path)
    })
  }
}
