/**
 * The follow half of a MOVE: after a document's path changes, repoint the
 * references other documents wrote to its old path. Display-name changes
 * rewrite nothing — name references are being retired from resolution
 * (path + id only; names become render-time display), so there is no name
 * half to follow.
 *
 * Which aliases move, and to what, is `planReferenceRewrite` in codec — the
 * same package whose scanner and resolver decide what a reference IS, so
 * what gets rewritten cannot drift from what resolves (ADR-0014's bar).
 * This module is only the server's application of that plan: find the
 * documents whose content names an affected alias, load each, rewrite, save.
 *
 * Candidates come from the same stamp-validated `ContentFactsCache` that
 * serves backlinks, whose per-document `refs` hold each target AS WRITTEN —
 * so only documents that actually spell an old alias are ever loaded. A
 * rename is a rare, user-initiated operation; the per-candidate load is the
 * cheap part and the cache spares the scan.
 *
 * One candidate failing to load or save must not abort the rest: the rename
 * itself has already happened, so every reference this pass CAN repair is
 * one fewer silently broken link. The ids it could not repair are reported
 * to the caller, who owns deciding whether that is worth a log line.
 */
import {
  type DocumentMove,
  planReferenceRewrite,
  rewriteCanvasReferences,
  rewriteReferenceTargets,
} from '@kamiazya/whiteboard-codec'
import {
  readDocumentKind,
  readMarkdownBody,
  readSpatialCanvas,
  writeMarkdownBody,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentId } from '@kamiazya/whiteboard-model'
import type { ServerDeps } from '../server-deps.js'
import { loadOrCreateDocument, saveDocumentSnapshot } from '../tools/document-io.js'
import { ContentFactsCache } from './content-facts-cache.js'

export interface FollowRenameInput {
  readonly workspaceId: string
  /**
   * The workspace listing BEFORE the index mutation — the table the old
   * aliases resolved against. The caller holds it because only the caller
   * exists on both sides of the mutation.
   */
  readonly entriesBefore: readonly {
    readonly documentId: string
    readonly path: string
  }[]
  /**
   * One entry per document the path change carried — a move is a SUBTREE
   * move, so derive these with codec's `movesForPathChange` rather than
   * passing the root alone.
   */
  readonly moves: readonly DocumentMove[]
}

export interface FollowRenameResult {
  /** Documents whose content was rewritten and saved, in listing order. */
  readonly updatedDocumentIds: readonly string[]
  /** Candidates that failed to load or save; the rename itself stands. */
  readonly failedDocumentIds: readonly string[]
}

export async function followReferencesAfterRename(
  deps: ServerDeps,
  input: FollowRenameInput,
  cache: ContentFactsCache = new ContentFactsCache(),
): Promise<FollowRenameResult> {
  const plan = planReferenceRewrite({
    entries: input.entriesBefore.map((entry) => ({
      id: entry.documentId,
      path: entry.path,
    })),
    moves: input.moves,
  })
  if (plan.size === 0) return { updatedDocumentIds: [], failedDocumentIds: [] }

  const entries = await deps.documentIndex.listDocuments({ workspaceId: input.workspaceId })
  const facts = await cache.factsFor(deps, input.workspaceId, entries)

  const updated: string[] = []
  const failed: string[] = []
  for (const entry of entries) {
    const refs = facts.get(entry.documentId)?.refs
    if (refs === undefined || !refs.some((ref) => plan.has(ref.target))) continue
    try {
      const doc = await loadOrCreateDocument(
        deps,
        input.workspaceId,
        entry.documentId as DocumentId,
      )
      if (readDocumentKind(doc) === 'spatial') {
        const result = rewriteCanvasReferences(readSpatialCanvas(doc), plan)
        if (!result.changed) continue
        // Targeted writes, never a whole-canvas resync: readSpatialCanvas
        // drops records the current schema cannot parse, and writing the
        // whole canvas back would DELETE them.
        for (const node of result.changedNodes) writeSpatialNode(doc, node)
      } else {
        const body = readMarkdownBody(doc)
        const next = rewriteReferenceTargets(body, plan)
        if (next === body) continue
        writeMarkdownBody(doc, next)
      }
      await saveDocumentSnapshot(deps, input.workspaceId, entry.documentId as DocumentId, doc)
      updated.push(entry.documentId)
    } catch {
      failed.push(entry.documentId)
    }
  }
  return { updatedDocumentIds: updated, failedDocumentIds: failed }
}
