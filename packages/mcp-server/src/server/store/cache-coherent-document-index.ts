import { readWorkspaceNodes } from '@kamiazya/whiteboard-loro-adapter'
import {
  type BlobStore,
  type CreateWorkspaceInput,
  createWorkspaceInputSchema,
  type RenameWorkspaceInput,
  renameWorkspaceInputSchema,
  type WorkspaceEntry,
} from '@kamiazya/whiteboard-ports'
import {
  LoroWorkspaceDocumentIndex,
  type WorkspaceDocs,
  type WorkspaceRegistry,
} from '@kamiazya/whiteboard-workspace-index'
import { upsertWorkspaceRow } from './db/upsert-workspace.js'
import { evictDoc } from './doc-cache.js'
import { globalStoreScope, type StoreScope } from './store-scope.js'
import { openWorkspaceDocIfStored } from './workspace-doc-cache.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

/**
 * The tree index, with this composition root's doc-cache kept coherent
 * around the moves and deletes the port performs. The cache is keyed by
 * (workspaceId, path); a move leaves every touched path holding a doc filed
 * under a name that no longer means what it did — the SOURCE half merely
 * stales, while the DESTINATION half corrupts: `getDoc` lazily creates an
 * empty doc for any path, so a read that arrived before the move left a
 * phantom cached there, and the next write through it would persist the
 * phantom over the moved document's real content. The shared index cannot
 * know this cache exists, so the composition root wraps it.
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
    super(docs, blobs, registry)
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
    return withWorkspaceWriteLock(parsed.workspaceId, async () => {
      await upsertWorkspaceRow(await this.scope.db(), parsed.workspaceId, {
        ...(parsed.segment === undefined ? {} : { segment: parsed.segment }),
        ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
      })
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

  override async setDocumentName(
    input: Parameters<LoroWorkspaceDocumentIndex['setDocumentName']>[0],
  ): Promise<void> {
    return withWorkspaceWriteLock(input.workspaceId, () => super.setDocumentName(input))
  }

  override async restoreDocument(
    input: Parameters<LoroWorkspaceDocumentIndex['restoreDocument']>[0],
  ): ReturnType<LoroWorkspaceDocumentIndex['restoreDocument']> {
    return withWorkspaceWriteLock(input.workspaceId, () => super.restoreDocument(input))
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
      // Collected BEFORE the move: afterwards the tree is the only record of
      // the subtree, under its new paths.
      const workspaceDoc = await openWorkspaceDocIfStored(input.workspaceId, this.scope)
      const movedPaths =
        workspaceDoc === null
          ? []
          : readWorkspaceNodes(workspaceDoc)
              .map((node) => node.path)
              .filter((path) => path === input.from || path.startsWith(`${input.from}/`))
      await super.moveDocument(input)
      for (const from of movedPaths) {
        evictDoc(input.workspaceId, from, this.scope)
        evictDoc(
          input.workspaceId,
          from === input.from ? input.to : `${input.to}${from.slice(input.from.length)}`,
          this.scope,
        )
      }
    })
  }

  override async deleteDocument(input: { workspaceId: string; path: string }): Promise<void> {
    return withWorkspaceWriteLock(input.workspaceId, async () => {
      await super.deleteDocument(input)
      evictDoc(input.workspaceId, input.path, this.scope)
    })
  }
}
