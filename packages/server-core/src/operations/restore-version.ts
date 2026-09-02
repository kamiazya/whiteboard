import {
  projectWorkspaceDocument,
  readWorkspaceNodes,
  reconcileDocContent,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { documentPathSchema } from '@kamiazya/whiteboard-model'
import { DocumentPathTakenError } from '@kamiazya/whiteboard-ports'
import type { LoroDoc } from 'loro-crdt'
import { countAliveNodes } from '../document-counts.js'
import type { LiveDocuments, ServerDeps } from '../server-deps.js'

export interface RestoreVersionInput {
  readonly workspaceId: string
  /** The SOURCE document — the one whose history holds `versionId`. */
  readonly path: string
  readonly versionId: string
  /** Restore into another document instead of in place. `=== path` collapses into in-place. */
  readonly targetPath?: string
  readonly overwrite?: boolean
  /** Roll the document AND every descendant back; needs a workspace-scoped version. */
  readonly subtree?: boolean
}

export interface RestoreProgressEvent {
  readonly workspaceId: string
  /** The document being written — the target for a targetPath restore. */
  readonly path: string
  readonly phase: 'started' | 'complete'
  readonly label?: string
}

/**
 * How a surface hears that a restore began and ended. Awaited, so an
 * implementation may resolve a lazy transport first; the `complete` event is
 * sent from a `finally`, so a client overlay cannot stay locked when the
 * body throws.
 */
export type RestoreProgress = (event: RestoreProgressEvent) => void | Promise<void>

export type RestoreVersionResult =
  | { kind: 'not-found' }
  | { kind: 'invalid-target-path' }
  | { kind: 'output-exists'; targetPath: string }
  | { kind: 'subtree-takes-no-target' }
  | { kind: 'subtree-needs-workspace-version' }
  | { kind: 'restored-in-place' }
  | { kind: 'restored-to-target'; targetPath: string; elementCount: number }
  | { kind: 'restored-subtree'; restoredCount: number }

/**
 * Restores a document (or its whole subtree) to a saved version from the
 * FILE-BACKED history behind `deps.versions`. Three modes share it:
 *
 *   1. In-place reconcile (default). CRDTs cannot forget history, so restore
 *      commits NEW ops whose result equals the past state:
 *        only in past    -> insert into current, or un-tombstone + restore fields
 *        only in current -> set isDeleted=true (tombstone)
 *        in both         -> copy differing fields from past onto current
 *
 *   2. Restore into `targetPath`. A path not yet taken gets the past doc as
 *      a brand-new document carrying the SOURCE's kind; an existing one
 *      needs `overwrite` and goes through the SAME reconcile-onto-the-live-
 *      doc path as mode 1 — never a file swap, because a delta broadcast
 *      only means something against the doc it was diffed from.
 *
 *   3. Subtree rollback (`subtree`, only with no distinct target): the
 *      document and every descendant go back to this version's state —
 *      reverts, resurrections and deletions alike, each as ordinary new
 *      edits. Needs a workspace-scoped version: a per-document version
 *      cannot say where its siblings were.
 *
 * THE OPERATION HOLDS THE LOCK. Every read and write of every mode runs
 * inside one `liveDocuments.withWriteLock` hold — `get` alone is unlocked at
 * the store, so a concurrent delete/rename landing between an unlocked read
 * and the eventual save would silently insert a phantom canvas (or resurrect
 * content onto a path the delete just cleared). Holding it here rather than
 * in an adapter means a second surface cannot forget it — the same reasoning
 * that put `documentTeardown.around` inside the delete operation.
 *
 * `targetPath` is validated HERE against model's `documentPathSchema` as the
 * backstop no surface can skip; an adapter with richer per-segment
 * diagnostics may still run its own validation for the message.
 */
export async function restoreVersion(
  deps: Pick<ServerDeps, 'versions' | 'liveDocuments'>,
  input: RestoreVersionInput,
  progress: RestoreProgress = () => {},
): Promise<RestoreVersionResult> {
  const { versions, liveDocuments: live } = deps
  const { workspaceId, path, versionId } = input
  return live.withWriteLock(workspaceId, async () => {
    const doc = await live.get(workspaceId, path)
    const past = await versions.load(workspaceId, versionId)
    if (past === null) return { kind: 'not-found' }

    const targetPath = input.targetPath
    if (targetPath !== undefined && targetPath !== path) {
      if (!documentPathSchema.safeParse(targetPath).success) {
        return { kind: 'invalid-target-path' }
      }
      if (input.subtree === true) return { kind: 'subtree-takes-no-target' }

      const targetAlreadyExists = await live.exists(workspaceId, targetPath)
      if (targetAlreadyExists && input.overwrite !== true) {
        return { kind: 'output-exists', targetPath }
      }

      if (targetAlreadyExists) {
        // The version id belongs to the SOURCE document's history, so its
        // label lives in the source's version list even though the reconcile
        // lands on the target.
        const label = await labelOf(versions, workspaceId, path, versionId)
        const targetDoc = await live.get(workspaceId, targetPath)
        // The merged content is the source's own shape (spatial nodes/edges
        // vs. a markdown body), so the target's stored kind must follow it or
        // a kind-aware consumer (editor routing) opens the overwritten
        // document with the wrong editor.
        const sourceKind = await live.kind(workspaceId, path)
        await reconcileAndSave(live, workspaceId, targetPath, targetDoc, past, {
          label,
          kind: sourceKind,
          progress,
        })
        return {
          kind: 'restored-to-target',
          targetPath,
          elementCount: countAliveNodes(targetDoc),
        }
      }

      // Genuinely new document: no live doc and no connected clients, so
      // there is nothing to reconcile against. The restored content is
      // whatever the source stores, so the new row carries the source's own
      // kind rather than the store default.
      try {
        const sourceKind = await live.kind(workspaceId, path)
        await live.save(workspaceId, targetPath, past, {
          overwrite: false,
          ...(sourceKind !== null ? { kind: sourceKind } : {}),
        })
      } catch (err) {
        if (err instanceof DocumentPathTakenError) {
          return { kind: 'output-exists', targetPath }
        }
        throw err
      }
      // Guard against a stale cache entry from a since-deleted document at
      // this path being served instead of the just-written snapshot.
      live.evict(workspaceId, targetPath)
      return { kind: 'restored-to-target', targetPath, elementCount: countAliveNodes(past) }
    }

    if (input.subtree === true) {
      const pastWorkspace = await versions.loadWorkspaceAt(workspaceId, versionId)
      if (pastWorkspace === null) return { kind: 'subtree-needs-workspace-version' }
      const inSubtree = (p: string) => p === path || p.startsWith(`${path}/`)
      const pastDocs = readWorkspaceNodes(pastWorkspace).flatMap((node) =>
        node.type === 'document' && inSubtree(node.path) ? [node] : [],
      )
      const pastIds = new Set(pastDocs.map((node) => node.meta.documentId))
      // A row without an id cannot be correlated to the version and is left
      // alone.
      const rows = (await live.list(workspaceId)).flatMap((row) =>
        row.id === undefined ? [] : [{ id: row.id, path: row.path }],
      )
      const rowsById = new Map(rows.map((row) => [row.id, row]))
      const label = await labelOf(versions, workspaceId, path, versionId)
      await progress({
        workspaceId,
        path,
        phase: 'started',
        ...(label === undefined ? {} : { label }),
      })
      try {
        // Deletions first, so a past document whose path a later-born one
        // occupies can land after the squatter is gone. The tree delete
        // EVACUATES, so nothing here is unrecoverable.
        for (const row of rows) {
          if (inSubtree(row.path) && !pastIds.has(row.id)) {
            await live.delete(workspaceId, row.path)
          }
        }
        for (const node of pastDocs) {
          const pastDoc = projectWorkspaceDocument(pastWorkspace, node.meta.documentId)
          if (pastDoc === null) continue
          const liveRow = rowsById.get(node.meta.documentId)
          if (liveRow !== undefined) {
            if (liveRow.path !== node.path) {
              await live.rename(workspaceId, liveRow.path, node.path)
            }
            const liveDoc = await live.get(workspaceId, node.path)
            reconcileDocContent(liveDoc, pastDoc)
            await live.save(workspaceId, node.path, liveDoc, {
              overwrite: true,
              kind: node.meta.kind,
            })
          } else {
            // Deleted since the version: recreated under the SAME
            // documentId's row lineage as far as the tree is concerned (the
            // write-through places it by path + kind).
            await live.save(workspaceId, node.path, pastDoc, { kind: node.meta.kind })
            live.evict(workspaceId, node.path)
          }
        }
      } finally {
        await progress({ workspaceId, path, phase: 'complete' })
      }
      return { kind: 'restored-subtree', restoredCount: pastDocs.length }
    }

    const label = await labelOf(versions, workspaceId, path, versionId)
    await reconcileAndSave(live, workspaceId, path, doc, past, { label, kind: null, progress })
    return { kind: 'restored-in-place' }
  })
}

async function labelOf(
  versions: Pick<ServerDeps, 'versions'>['versions'],
  workspaceId: string,
  path: string,
  versionId: string,
): Promise<string | undefined> {
  return (await versions.list(workspaceId, path)).find((v) => v.id === versionId)?.label
}

// Reconciles `past` onto `doc` (the LIVE doc for workspaceId/targetPath),
// then persists — shared by the in-place restore and the overwrite-an-
// existing-document restore, because both must mutate the same document
// instance any connected client already holds.
async function reconcileAndSave(
  live: LiveDocuments,
  workspaceId: string,
  targetPath: string,
  doc: LoroDoc,
  past: LoroDoc,
  options: {
    label: string | undefined
    kind: DocumentKind | null
    progress: RestoreProgress
  },
): Promise<void> {
  const { label, kind, progress } = options
  await progress({
    workspaceId,
    path: targetPath,
    phase: 'started',
    ...(label === undefined ? {} : { label }),
  })
  try {
    try {
      reconcileDocContent(doc, past)
      await live.save(workspaceId, targetPath, doc, {
        overwrite: true,
        ...(kind !== null ? { kind } : {}),
      })
    } catch (err) {
      // reconcileDocContent mutates the live doc in place before the save
      // runs, so any failure here leaves the cache ahead of durable state.
      // Evict it so the next read reloads the last persisted snapshot.
      live.evict(workspaceId, targetPath)
      throw err
    }
  } finally {
    // Always send complete, even on error, or a client overlay can stay
    // locked forever.
    await progress({ workspaceId, path: targetPath, phase: 'complete' })
  }
}
