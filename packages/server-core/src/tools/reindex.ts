import type { WorkspaceId } from '@kamiazya/whiteboard-canvas-model'
import { reassembleSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import { deriveWorkspaceIndexRows, readFacets } from '@kamiazya/whiteboard-canvas-workspace'
import type { CanvasIndexInput } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { getLogger } from '../log.js'
import type { ServerDeps } from '../server-deps.js'
import { loadWorkspaceTree } from './workspace-tree-io.js'

const log = getLogger('reindex')

/**
 * Loads the per-canvas input `deriveWorkspaceIndexRows` needs. Never
 * throws: a canvas whose doc cannot be loaded/parsed is skipped (logged),
 * rather than aborting the reindex for every other canvas in the
 * workspace over one bad doc.
 *
 * `coreFacets`/`resolvedBody` are omitted here — this composition targets
 * spatial (JSON Canvas) documents, which have no persisted core-facets
 * bucket or markdown body to resolve backlinks from yet. `updatedAtMs`
 * has no persisted source either (no per-doc modified timestamp is
 * tracked today), so it is stamped at reindex time; this is an accepted
 * approximation, not a claim that it reflects the doc's actual last-write
 * time.
 */
async function loadCanvasIndexInput(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  canvasId: string,
): Promise<CanvasIndexInput | undefined> {
  try {
    const result = await deps.canvasDocStore.loadSnapshot({
      docRef: { kind: 'canvas', canvasId },
    })
    if (result === null) {
      return { canvasId, updatedAtMs: Date.now() }
    }

    const doc = new LoroDoc()
    doc.import(reassembleSnapshot(result.manifest, result.chunks))
    const extensionFacets = readFacets(doc)

    return {
      canvasId,
      updatedAtMs: Date.now(),
      extensionFacets: Object.keys(extensionFacets).length > 0 ? extensionFacets : undefined,
    }
  } catch (err) {
    log.error('skipped canvas while reindexing; doc could not be loaded', {
      workspaceId,
      canvasId,
      err,
    })
    return undefined
  }
}

/**
 * Rebuilds every WorkspaceIndex row for `workspaceId` from the currently
 * persisted state (the workspace tree plus every canvas doc it
 * references) and applies the full row set in one `applyRows` call.
 *
 * Callable two ways:
 *  - After a mutation, so the index reflects the just-persisted change.
 *  - On demand / at startup (`reindexAllWorkspaces` callers), to backfill
 *    a workspace whose index was never populated.
 *
 * Performance note: this loads every canvas LoroDoc in the workspace on
 * every call — acceptable for the small canvas counts this ships with
 * today. An incremental/delta reindex is deferred until workspace size
 * makes a full reload a real cost.
 *
 * Never throws: loading the workspace tree, loading/deriving the row set,
 * and the `applyRows` call are each guarded, and any failure is logged at
 * `error` level and swallowed. A transient index-store error, or a corrupt
 * workspace-tree manifest, never blocks the mutation whose state has
 * already been persisted. The index is eventually consistent, not a gate
 * on mutation success.
 */
export async function reindexWorkspace(deps: ServerDeps, workspaceId: WorkspaceId): Promise<void> {
  let rows: ReturnType<typeof deriveWorkspaceIndexRows>
  try {
    const tree = await loadWorkspaceTree(deps.canvasDocStore, workspaceId)
    const nodes = tree.snapshot().nodes

    const canvases: CanvasIndexInput[] = []
    for (const node of nodes) {
      const input = await loadCanvasIndexInput(deps, workspaceId, node.canvasId)
      if (input !== undefined) canvases.push(input)
    }

    rows = deriveWorkspaceIndexRows({ workspaceId, tree, canvases })
  } catch (err) {
    log.error('failed to derive workspace index rows; skipping index update', {
      workspaceId,
      err,
    })
    return
  }

  try {
    await deps.workspaceIndex.applyRows(rows)
  } catch (err) {
    log.error('failed to apply workspace index rows', { workspaceId, err })
  }
}

/**
 * Backfill entrypoint for composition roots: reindexes every workspace
 * they know about. `workspaceIds` is caller-supplied because this shared
 * layer has no "list all workspaces" port of its own — the composition
 * root's store implementation is what actually knows the full set.
 */
export async function reindexAllWorkspaces(
  deps: ServerDeps,
  workspaceIds: readonly WorkspaceId[],
): Promise<void> {
  for (const workspaceId of workspaceIds) {
    await reindexWorkspace(deps, workspaceId)
  }
}
