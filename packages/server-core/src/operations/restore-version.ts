import {
  projectWorkspaceDocument,
  readDocumentKind,
  readWorkspaceNodes,
  reconcileDocContent,
} from '@kamiazya/whiteboard-loro-adapter'
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
    /**
     * Roll the document AND every descendant back to this version's state —
     * reverts, resurrections and deletions alike, each as an ordinary new
     * edit, since nothing rewinds in a CRDT.
     */
    subtree: z.boolean().optional(),
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
  z.object({ kind: z.literal('subtree'), restoredCount: z.number().int().min(0) }).strict(),
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

/**
 * A subtree rollback needs the whole workspace at that point, and this
 * version does not carry it.
 *
 * Not a "not found": the version exists, it is simply per-document, and a
 * per-document version cannot say where the document's SIBLINGS were. The
 * seam answers `null` for exactly that, which is a real answer rather than
 * a failure, so the refusal has to be its own condition.
 */
export class NotWorkspaceScopedError extends Error {
  constructor(readonly versionId: string) {
    super(`subtree rollback needs a workspace-scoped version: ${versionId}`)
    this.name = 'NotWorkspaceScopedError'
  }
}

/** A subtree rollback was asked to write somewhere other than where it rolls back. */
export class SubtreeTargetError extends Error {
  constructor() {
    super('subtree rollback cannot take a targetPath')
    this.name = 'SubtreeTargetError'
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
  const { workspaceId, path, versionId, targetPath, overwrite, subtree } =
    restoreVersionInputSchema.parse(input)

  const entry = await deps.documentIndex.resolveDocument({ workspaceId, path })
  if (entry === null) throw new RestoreTargetNotFoundError(path)

  if (subtree === true) {
    if (targetPath !== undefined && targetPath !== path) throw new SubtreeTargetError()
    return await rollBackSubtree(deps, { workspaceId, path, versionId })
  }

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

/**
 * Roll a document and every descendant back to a workspace-scoped version.
 *
 * DELETIONS RUN FIRST, and the order is load-bearing: a document that
 * existed at the version may sit at a path some later-born document now
 * occupies, and it cannot land until the squatter is gone. The index's
 * delete evacuates rather than destroys, so nothing here is unrecoverable.
 *
 * A document alive at both points is RECONCILED in place rather than
 * recreated, for the same reason the overwrite mode is: a client may be
 * holding it, and a wholesale replacement would strand that client's own
 * history. One that was deleted since the version has no holder, so it is
 * written outright.
 */
async function rollBackSubtree(
  deps: ServerDeps,
  input: { workspaceId: string; path: string; versionId: string },
): Promise<RestoreVersionOutput> {
  const { workspaceId, path, versionId } = input
  const pastWorkspace = await deps.versions.loadWorkspaceAt(workspaceId, versionId)
  if (pastWorkspace === null) throw new NotWorkspaceScopedError(versionId)

  const inSubtree = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`)
  const pastDocs = readWorkspaceNodes(pastWorkspace).flatMap((node) =>
    node.type === 'document' && inSubtree(node.path) ? [node] : [],
  )
  const pastIds = new Set(pastDocs.map((node) => node.meta.documentId))
  const live = await deps.documentIndex.listDocuments({ workspaceId })
  const liveById = new Map(live.map((entry) => [entry.documentId, entry]))

  for (const entry of live) {
    if (inSubtree(entry.path) && !pastIds.has(entry.documentId)) {
      await deps.documentIndex.deleteDocument({ workspaceId, path: entry.path })
    }
  }

  for (const node of pastDocs) {
    const pastDoc = projectWorkspaceDocument(pastWorkspace, node.meta.documentId)
    // A node the workspace record holds but cannot project has no content to
    // restore; skipping is the honest answer, not an error for the caller.
    if (pastDoc === null) continue
    const existing = liveById.get(node.meta.documentId)
    if (existing === undefined) {
      const created = await deps.documentIndex.createDocument({
        workspaceId,
        path: node.path,
        kind: node.meta.kind ?? readDocumentKind(pastDoc) ?? 'spatial',
      })
      await saveDocumentSnapshot(deps, workspaceId, created.documentId, pastDoc)
      continue
    }
    if (existing.path !== node.path) {
      await deps.documentIndex.moveDocument({ workspaceId, from: existing.path, to: node.path })
    }
    const { doc } = await loadDocument(deps, workspaceId, existing.documentId)
    reconcileDocContent(doc, pastDoc)
    await saveDocumentSnapshot(deps, workspaceId, existing.documentId, doc)
  }

  return { kind: 'subtree', restoredCount: pastDocs.length }
}
