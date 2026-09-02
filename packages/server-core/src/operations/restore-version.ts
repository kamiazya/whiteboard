import { readDocumentKind, reconcileDocContent } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { documentPathSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import type { LoroDoc } from 'loro-crdt'
import { z } from 'zod'
import { countAliveNodes } from '../document-counts.js'
import type { ServerDeps } from '../server-deps.js'
import { loadDocument, saveDocumentSnapshot } from '../tools/document-io.js'

/**
 * Restoring a document to a saved version — the operation, expressed over
 * ports and seams so any surface can perform it.
 *
 * It is addressed by PATH on the way in, because that is what a caller
 * names, and by documentId everywhere after. That is not incidental: the
 * hazard the route-level implementation guards against at length — a
 * concurrent delete or rename between the read and the save leaving the
 * write to insert a phantom document at a path whose row is gone — is a
 * property of addressing by PATH. An id is stable across a rename and
 * absent after a delete, so resolving once and working by id is what
 * removes the hazard rather than defending against it.
 */
export const restoreVersionInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    path: documentPathSchema,
    versionId: z.string().min(1),
    /**
     * Restore into a DIFFERENT document instead of onto the source.
     * Equal to `path` collapses to the in-place mode: a caller restoring
     * onto their own document should not have to pass `overwrite` against
     * themselves, nor be refused for colliding with the document they are
     * restoring.
     */
    targetPath: documentPathSchema.optional(),
    /** Required to replace a target that already exists. */
    overwrite: z.boolean().optional(),
  })
  .strict()
export type RestoreVersionInput = z.infer<typeof restoreVersionInputSchema>

export const restoreVersionOutputSchema = z.union([
  z.object({ kind: z.literal('in-place') }).strict(),
  z
    .object({
      kind: z.literal('into-target'),
      documentId: z.string(),
      /**
       * Nodes alive in the restored content — an advisory count for the
       * caller's confirmation copy, not a contract about the document.
       */
      elementCount: z.number().int().min(0),
    })
    .strict(),
])
export type RestoreVersionOutput = z.infer<typeof restoreVersionOutputSchema>

/**
 * The named version does not exist in this workspace's history.
 *
 * A class rather than a `null` return, for the reason `SnapshotNotFoundError`
 * is one: every caller has to map it to a refusal, and a nullable result is
 * the shape a caller forgets to check. Distinct from the seam answering
 * `null`, which is the fact this is raised FROM.
 */
export class VersionNotFoundError extends Error {
  constructor(readonly versionId: string) {
    super(`no such version: ${versionId}`)
    this.name = 'VersionNotFoundError'
  }
}

/**
 * The target already holds a document and the caller did not pass
 * `overwrite`. Raised BEFORE anything is written, so a refusal leaves the
 * occupant exactly as it was.
 */
export class TargetExistsError extends Error {
  constructor(readonly targetPath: string) {
    super(`target already exists: ${targetPath}`)
    this.name = 'TargetExistsError'
  }
}

/** The document named by `path` is not in this workspace's index. */
export class RestoreTargetNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`no such document: ${path}`)
    this.name = 'RestoreTargetNotFoundError'
  }
}

export async function restoreVersion(
  deps: ServerDeps,
  input: RestoreVersionInput,
): Promise<RestoreVersionOutput> {
  const { workspaceId, path, versionId, targetPath, overwrite } =
    restoreVersionInputSchema.parse(input)

  const entry = await deps.documentIndex.resolveDocument({ workspaceId, path })
  if (entry === null) throw new RestoreTargetNotFoundError(path)

  const past = await deps.versions.load(workspaceId, versionId)
  if (past === null) throw new VersionNotFoundError(versionId)

  if (targetPath !== undefined && targetPath !== path) {
    return await restoreIntoTarget(deps, {
      workspaceId,
      targetPath,
      overwrite: overwrite === true,
      sourceKind: entry.kind,
      past,
    })
  }

  const { doc } = await loadDocument(deps, workspaceId, entry.documentId)
  // A DIFF, not an import: nothing rewinds in a CRDT, so a restore is a NEW
  // edit whose RESULT equals the past state. Importing the past doc's
  // history instead would be a no-op for a same-lineage checkout (the live
  // doc already has every op) and would lose to the live doc's later ops
  // across lineages.
  reconcileDocContent(doc, past)
  await saveDocumentSnapshot(deps, workspaceId, entry.documentId, doc)

  return { kind: 'in-place' }
}

/**
 * Restore into a document other than the source.
 *
 * The two branches are NOT the same operation with a flag. An existing
 * target is RECONCILED, exactly as an in-place restore is, because a client
 * may be holding it — a content swap would leave that client's document and
 * the stored one disagreeing. A target that does not exist yet has no
 * holder and no content to reconcile against, so it is created outright.
 *
 * Either way the target's kind follows the SOURCE's: the restored content
 * is whatever the source stores (spatial nodes/edges vs. a markdown body),
 * and a kind-aware reader opening it under the wrong kind gets the wrong
 * editor.
 */
async function restoreIntoTarget(
  deps: ServerDeps,
  input: {
    workspaceId: string
    targetPath: string
    overwrite: boolean
    sourceKind: DocumentKind | undefined
    past: LoroDoc
  },
): Promise<RestoreVersionOutput> {
  const { workspaceId, targetPath, overwrite, sourceKind, past } = input
  const existing = await deps.documentIndex.resolveDocument({ workspaceId, path: targetPath })

  if (existing !== null) {
    if (!overwrite) throw new TargetExistsError(targetPath)
    const { doc } = await loadDocument(deps, workspaceId, existing.documentId)
    reconcileDocContent(doc, past)
    await saveDocumentSnapshot(deps, workspaceId, existing.documentId, doc)
    return {
      kind: 'into-target',
      documentId: existing.documentId,
      elementCount: countAliveNodes(doc),
    }
  }

  // The same fallback chain the route-level save resolved: the source's
  // recorded kind, else what the restored content itself declares, else
  // spatial. A pre-kind source row has no recorded kind and still has to
  // produce a copy that opens in the right editor.
  const created = await deps.documentIndex.createDocument({
    workspaceId,
    path: targetPath,
    kind: sourceKind ?? readDocumentKind(past) ?? 'spatial',
  })
  await saveDocumentSnapshot(deps, workspaceId, created.documentId, past)
  return {
    kind: 'into-target',
    documentId: created.documentId,
    elementCount: countAliveNodes(past),
  }
}
