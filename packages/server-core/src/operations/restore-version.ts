import {
  openStandalone,
  type RecordSession,
  type RecordView,
  type SyncTextBreach,
  type WorkspaceNode,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import {
  bytesToBase64,
  documentPathSchema,
  isSelfOrDescendant,
  messageOf,
} from '@kamiazya/whiteboard-model'
import { DocumentPathTakenError } from '@kamiazya/whiteboard-ports'
import { getLogger } from '../log.js'
import type { LiveDocuments, RestoreProgressEvent, ServerDeps } from '../server-deps.js'
import { DocumentKindChangedError, textBreachRefusal } from './sync-write-refusals.js'

/** What a restore reaches: the history, the live documents, the record it writes into, and the write observer. */
export type RestoreDeps = Pick<
  ServerDeps,
  'versions' | 'liveDocuments' | 'workspaceDocuments' | 'documentWritten'
>

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
  | {
      kind: 'kind-mismatch'
      targetPath: string
      sourceKind: DocumentKind
      targetKind: DocumentKind
    }
  | { kind: 'subtree-takes-no-target' }
  | { kind: 'subtree-needs-workspace-version' }
  | { kind: 'restored-in-place' }
  | {
      kind: 'restored-to-target'
      targetPath: string
      /** The document now holding the saved state — the target's own id, never the source's. */
      documentId: string
      elementCount: number
    }
  | { kind: 'restored-subtree'; restoredCount: number }

/**
 * What all three modes have in hand once the version is resolved: the live
 * document, the past state, and how to narrate the write.
 */
interface RestoreContext {
  readonly deps: RestoreDeps
  readonly workspaceId: string
  /** The SOURCE document, whose history holds the version. */
  readonly path: string
  readonly versionId: string
  /** The past document, opened as a record of its own, for what is judged of it. */
  readonly past: RecordSession
  /** The same past document as the bytes a write at the record's node takes. */
  readonly pastBytes: Uint8Array
  readonly label: string | undefined
  readonly progress: RestoreProgress
}

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
 *      only means something against the doc it was diffed from. A kind is
 *      written once, at birth, so an existing target of the OTHER kind is
 *      refused (`kind-mismatch`) rather than converted: the reconcile would
 *      replace its whole content with the other kind's shape.
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
 *
 * A saved state past a limit the sync surface enforces is refused before any
 * write, thrown as that surface's `TextBreachRefusalError`: a version is
 * written back as it stands, and one a promote carried names a state no sync
 * write judged (`withinSyncLimits`).
 */
export async function restoreVersion(
  deps: RestoreDeps,
  input: RestoreVersionInput,
  progress: RestoreProgress = () => {},
): Promise<RestoreVersionResult> {
  const { versions, liveDocuments: live } = deps
  const { workspaceId, path, versionId } = input
  return live.withWriteLock(workspaceId, async () => {
    const pastBytes = await versions.load(workspaceId, versionId)
    if (pastBytes === null) return { kind: 'not-found' }
    const standalone = await openStandalone(pastBytes)
    try {
      // A version id is unique per WORKSPACE, so `load` alone would answer
      // another document's past state — and the reconcile below would then
      // overwrite this document with unrelated content. The history named by
      // `path` has to hold the id; one that does not is, to this caller, a
      // version that does not exist. The same row carries the label the
      // progress events show.
      const owned = (await versions.list(workspaceId, path)).find((v) => v.id === versionId)
      if (owned === undefined) return { kind: 'not-found' }

      const ctx: RestoreContext = {
        deps,
        workspaceId,
        path,
        versionId,
        past: standalone.session,
        pastBytes,
        label: owned.label,
        progress,
      }

      // The three modes the header describes, in the order they take
      // precedence. A `targetPath` equal to `path` collapses into in-place,
      // which is why it is compared rather than merely present.
      const { targetPath } = input
      if (targetPath !== undefined && targetPath !== path) {
        return await restoreToTarget(live, versions, ctx, targetPath, input)
      }
      if (input.subtree === true) {
        return await restoreSubtree(live, versions, ctx)
      }
      return await restoreInPlace(live, versions, ctx)
    } finally {
      standalone.release()
    }
  })
}

/** Mode 3: reconcile the past onto the document that holds the history. */
async function restoreInPlace(
  live: LiveDocuments,
  versions: Pick<ServerDeps, 'versions'>['versions'],
  ctx: RestoreContext,
): Promise<RestoreVersionResult> {
  const { workspaceId, path, label, versionId } = ctx
  const written = await writePast(ctx, path, {
    label,
    kind: null,
    recorded: await live.kind(workspaceId, path),
  })
  // A document gone from the record between the history lookup and the write
  // (another process over the same data directory holds no lock of ours) is
  // one that does not exist, as the lookup would have answered a moment later.
  if (written === null) return { kind: 'not-found' }
  if (written.changed) await recordMerge(versions, workspaceId, path, versionId)
  return { kind: 'restored-in-place' }
}

/**
 * The overwrite arm of mode 2: reconcile the past onto the live target. A
 * target of the OTHER kind is refused before anything is written or announced,
 * because the reconcile replaces the whole content with the source's shape.
 */
async function restoreOntoExisting(
  live: LiveDocuments,
  versions: Pick<ServerDeps, 'versions'>['versions'],
  ctx: RestoreContext,
  targetPath: string,
): Promise<RestoreVersionResult> {
  const { workspaceId, path, label, versionId } = ctx
  const sourceKind = await live.kind(workspaceId, path)
  const targetKind = await live.kind(workspaceId, targetPath)
  if (sourceKind !== null && targetKind !== null && sourceKind !== targetKind) {
    return { kind: 'kind-mismatch', targetPath, sourceKind, targetKind }
  }
  // A target that records no kind is declared by the first write that
  // reaches it, so it takes the source's — the shape the merged content
  // has — and a kind-aware consumer (editor routing) opens it correctly.
  const written = await writePast(ctx, targetPath, {
    label,
    kind: targetKind === null ? sourceKind : null,
    recorded: targetKind ?? sourceKind,
    countElements: true,
  })
  if (written === null) return { kind: 'not-found' }
  const { changed, documentId, elementCount } = written
  if (changed) await recordMerge(versions, workspaceId, targetPath, versionId)
  return { kind: 'restored-to-target', targetPath, documentId, elementCount }
}

/** Mode 2: restore the past state into a DIFFERENT document. */
async function restoreToTarget(
  live: LiveDocuments,
  versions: Pick<ServerDeps, 'versions'>['versions'],
  ctx: RestoreContext,
  targetPath: string,
  input: RestoreVersionInput,
): Promise<RestoreVersionResult> {
  const { workspaceId } = ctx

  if (!documentPathSchema.safeParse(targetPath).success) {
    return { kind: 'invalid-target-path' }
  }
  if (input.subtree === true) return { kind: 'subtree-takes-no-target' }

  const targetAlreadyExists = await live.exists(workspaceId, targetPath)
  if (targetAlreadyExists && input.overwrite !== true) {
    return { kind: 'output-exists', targetPath }
  }

  if (targetAlreadyExists) return await restoreOntoExisting(live, versions, ctx, targetPath)

  return createTarget(live, versions, ctx, targetPath)
}

/**
 * Genuinely new document: no live doc and no connected clients, so there is
 * nothing to reconcile against. The restored content is whatever the source
 * stores, so the new row carries the source's own kind rather than the store
 * default.
 */
async function createTarget(
  live: LiveDocuments,
  versions: Pick<ServerDeps, 'versions'>['versions'],
  ctx: RestoreContext,
  targetPath: string,
): Promise<RestoreVersionResult> {
  const { workspaceId, path, past, pastBytes, versionId } = ctx
  const sourceKind = await live.kind(workspaceId, path)
  await withinSyncLimits(past, targetPath, sourceKind)
  try {
    await live.create(workspaceId, targetPath, pastBytes, {
      overwrite: false,
      ...(sourceKind !== null ? { kind: sourceKind } : {}),
    })
  } catch (err) {
    if (err instanceof DocumentPathTakenError) {
      return { kind: 'output-exists', targetPath }
    }
    throw err
  }
  await recordMerge(versions, workspaceId, targetPath, versionId)
  const documentId = await documentIdAt(live, workspaceId, targetPath)
  // A document a restore creates is written like any other: its checkpoint and
  // compaction are scheduled by the same observer.
  await announceWritten(ctx.deps, workspaceId, documentId, targetPath)
  return {
    kind: 'restored-to-target',
    targetPath,
    documentId,
    elementCount: await past.read({ query: 'spatialNodeCount' }, assertedAs<number>()),
  }
}

/**
 * The restore landed but the target's row lists no document id, so the
 * caller cannot be told which document now holds it. Named, so a server-mode
 * caller reads this rather than a bare internal error.
 */
class RestoredDocumentIdMissingError extends Error {
  constructor(public readonly targetPath: string) {
    super(`restored document has no id: ${targetPath}`)
    this.name = 'RestoredDocumentIdMissingError'
  }
}

/**
 * The id of the document a write just placed at `path`, read after the save
 * so a freshly created row is the one answered. A caller that restored into a
 * target goes on to address THAT document, so the source's id would send its
 * next edit to the wrong one. Throws rather than answering a path-shaped
 * stand-in: the row is there the moment `save` returns.
 */
async function documentIdAt(
  live: LiveDocuments,
  workspaceId: string,
  path: string,
): Promise<string> {
  const row = (await live.list(workspaceId)).find((candidate) => candidate.path === path)
  if (row?.documentId === undefined) {
    throw new RestoredDocumentIdMissingError(path)
  }
  return row.documentId
}

/**
 * The documents the version held in the subtree, and the past state of each
 * it can project — every one judged before the rollback's first deletion, so
 * a refusal leaves the subtree as it was rather than half rolled back.
 */
async function judgedPastSubtree(pastWorkspace: RecordView, inSubtree: (path: string) => boolean) {
  const nodes = await pastWorkspace.read(
    { query: 'nodes' },
    { parse: (value) => value as WorkspaceNode[] },
  )
  const pastDocs = nodes.flatMap((node) =>
    node.type === 'document' && inSubtree(node.path) ? [node] : [],
  )
  const restoring = pastDocs.flatMap((node) => {
    const bytes = pastWorkspace.exportProjection(node.meta.documentId)
    return bytes === null ? [] : [{ node, bytes }]
  })
  // One past document open at a time: each is judged and given back.
  for (const { node, bytes } of restoring) {
    const { session, release } = await openStandalone(bytes)
    try {
      await withinSyncLimits(session, node.path, node.meta.kind)
    } finally {
      release()
    }
  }
  return { pastDocs, restoring }
}

/** Mode 1: roll the document AND every descendant back together. */
async function restoreSubtree(
  live: LiveDocuments,
  versions: Pick<ServerDeps, 'versions'>['versions'],
  ctx: RestoreContext,
): Promise<RestoreVersionResult> {
  const { workspaceId, path, label, progress, versionId } = ctx

  const pastWorkspace = await versions.loadWorkspaceAt(workspaceId, versionId)
  if (pastWorkspace === null) return { kind: 'subtree-needs-workspace-version' }
  const inSubtree = (p: string) => isSelfOrDescendant(p, path)
  const { pastDocs, restoring } = await judgedPastSubtree(pastWorkspace, inSubtree).finally(() =>
    pastWorkspace.release(),
  )
  const pastIds = new Set(pastDocs.map((node) => node.meta.documentId))
  // A row without an id cannot be correlated to the version and is left
  // alone.
  const rows = (await live.list(workspaceId)).flatMap((row) =>
    row.documentId === undefined ? [] : [{ id: row.documentId, path: row.path }],
  )
  const rowsById = new Map(rows.map((row) => [row.id, row]))
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
    for (const { node, bytes } of restoring) {
      const row = rowsById.get(node.meta.documentId)
      const changed = await restoreOneDocument(ctx, node, bytes, row)
      // Every document the rollback moved gains the point, not just the
      // one that was addressed: leaving the rest unrecorded would make
      // this the one mode whose history reads as a straight line through
      // a merge. One it did not move gains none.
      if (changed) await recordMerge(versions, workspaceId, node.path, versionId)
    }
  } finally {
    await progress({ workspaceId, path, phase: 'complete' })
  }
  return { kind: 'restored-subtree', restoredCount: pastDocs.length }
}

/**
 * Puts ONE past document back where the version had it: moved into place and
 * reconciled when its row survived, recreated when it did not. Answers
 * whether that changed anything.
 */
async function restoreOneDocument(
  ctx: RestoreContext,
  node: { readonly path: string; readonly meta: { readonly kind?: DocumentKind } },
  pastBytes: Uint8Array,
  liveRow: { readonly path: string } | undefined,
): Promise<boolean> {
  const { deps, workspaceId } = ctx
  const live = deps.liveDocuments
  // Deleted since the version: recreated under the SAME documentId's row
  // lineage as far as the tree is concerned (the write-through places it
  // by path + kind).
  const recreate = async () => {
    await live.create(workspaceId, node.path, pastBytes, { kind: node.meta.kind })
    await announceWritten(
      deps,
      workspaceId,
      await documentIdAt(live, workspaceId, node.path),
      node.path,
    )
    return true
  }
  if (liveRow === undefined) return recreate()
  const moved = liveRow.path !== node.path
  if (moved) {
    await live.rename(workspaceId, liveRow.path, node.path)
  }
  const written = await writePastAtNode(
    deps,
    workspaceId,
    node.path,
    pastBytes,
    node.meta.kind ?? null,
  )
  // A row the record no longer holds is a document to recreate, not one to write into.
  return written === null ? recreate() : moved || written.changed
}

/**
 * Throws the sync surface's refusal when `past`, written whole, breaks a limit
 * that surface enforces — the same judgement, by `judgeStateWithinTextLimits`,
 * so a restore cannot store what no sync write could. That includes an
 * envelope stating another kind than the target records (`recorded`): the
 * restore writes the envelope back, and readers take its word over the node's.
 * Refused rather than restored without it, since a version that says it is
 * another kind is not the version the caller chose with one field changed.
 */
async function withinSyncLimits(
  past: RecordSession,
  path: string,
  recorded: DocumentKind | null | undefined,
): Promise<void> {
  const judged = await past.read({ query: 'documentJudgement' }, assertedAs<PastJudgement>())
  if (judged.textLimitBreach !== null) throw textBreachRefusal(judged.textLimitBreach, { path })
  // An envelope stating nothing defers to the record; one stating the kind it
  // records is no split.
  if (recorded != null && judged.statedKind !== null && judged.statedKind !== recorded) {
    throw new DocumentKindChangedError(recorded, judged.statedKind)
  }
}

/** What judging the past document answers: its breach of a sync limit and the kind its envelope states. */
interface PastJudgement {
  readonly textLimitBreach: SyncTextBreach | null
  readonly statedKind: DocumentKind | null
}

/**
 * Record the point a restore just created, on the document it changed.
 *
 * BEST EFFORT, deliberately: the content is already saved by the time this
 * runs, so a failure here costs the history a point and costs the document
 * nothing. Letting it throw would report a restore that in fact landed,
 * which is the worse of the two lies — and rolling the restore back to keep
 * the history tidy would be worse still. That is also why a keeper past its
 * restore-point ceiling refusing the point leaves the restore usable.
 */
async function recordMerge(
  versions: Pick<ServerDeps, 'versions'>['versions'],
  workspaceId: string,
  path: string,
  restoredFrom: string,
): Promise<void> {
  try {
    await versions.save(workspaceId, path, { auto: true, restoredFrom })
  } catch {
    // See above.
  }
}

/** What writing the past state at a document's node left: whether it moved the content, and the document's size. */
interface Written {
  readonly changed: boolean
  readonly documentId: string
  /** Counted only when the caller answers it: a restore in place does not. */
  readonly elementCount: number
}

interface NodeEntry {
  readonly documentId: string
  readonly kind: DocumentKind
}

// The engine answers in the shapes the loro-adapter readers return; this
// package asserts the type and holds no schema of its own for it.
const assertedAs = <T>() => ({ parse: (value: unknown) => value as T })

/**
 * Writes the past state as the content of the document at `path`, at its node
 * of the workspace record, then saves the record and drops the per-document
 * projections cut from it. Every part runs inside the hold the caller has on
 * the workspace write lock, and a throw anywhere after the record is opened
 * drops the record unsaved: the write already landed in it, and kept it would
 * ride the next ordinary save by anyone.
 *
 * Content and name are the keeper's one whole-content write — the content, then
 * the name a note at a generated path takes from its heading — split only so
 * that "changed" answers whether the CONTENT moved: an identical past writes no
 * operation, and a restore repeated over it records no merge point.
 */
async function writePastAtNode(
  deps: RestoreDeps,
  workspaceId: string,
  path: string,
  pastBytes: Uint8Array,
  requestedKind: DocumentKind | null,
  countElements = false,
): Promise<Written | null> {
  const { workspaceDocuments } = deps
  let written: Written | null
  try {
    written = await workspaceDocuments.withRecord(workspaceId, async (record) => {
      const wrote = await writeIntoRecord(record, path, pastBytes, requestedKind, countElements)
      if (wrote !== null) await record.save()
      return wrote
    })
  } catch (err) {
    workspaceDocuments.evict(workspaceId)
    throw err
  }
  // Nothing to write into: nothing was changed, and the record is as it was.
  if (written === null) return null
  if (written.changed) await announceWritten(deps, workspaceId, written.documentId, path)
  return written
}

/** The writes into the opened record: the kind when asked, the content, then the name; `null` when no document holds `path`. */
async function writeIntoRecord(
  record: RecordSession,
  path: string,
  pastBytes: Uint8Array,
  requestedKind: DocumentKind | null,
  countElements: boolean,
): Promise<Written | null> {
  const entry = await record.read(
    { query: 'workspaceDocumentEntry', args: { path } },
    assertedAs<NodeEntry | null>(),
  )
  if (entry === null) return null
  const { documentId } = entry
  // An EXPLICIT kind is an intentional sync request (a different-kind source's
  // content onto a target that records none); a plain restore leaves it.
  if (requestedKind !== null && entry.kind !== requestedKind) {
    record.write([
      { op: 'updateWorkspaceDocumentMeta', args: { documentId, patch: { kind: requestedKind } } },
    ])
  }
  const content = record.write([
    {
      op: 'writeWorkspaceDocumentContent',
      args: { documentId, source: bytesToBase64(pastBytes) },
    },
  ])
  record.write([{ op: 'seedNameFromTitle', args: { documentId } }])
  const elementCount = countElements
    ? await record.read({ query: 'spatialNodeCount', args: { documentId } }, assertedAs<number>())
    : 0
  return { documentId, changed: content.localUpdate !== undefined, elementCount }
}

/**
 * Tells the composition root a document was written, as a save does. After the
 * bytes are safe and never allowed to undo them: a scheduler that throws must
 * not turn a restore that landed into a failed one.
 */
async function announceWritten(
  deps: RestoreDeps,
  workspaceId: string,
  documentId: string,
  path: string,
): Promise<void> {
  try {
    await deps.documentWritten({ workspaceId, documentId, path })
  } catch (err) {
    getLogger('restore-version').warning(
      'the document-written observer failed after a successful restore',
      { workspaceId, documentId, err: messageOf(err) },
    )
  }
}

/**
 * Writes the past onto the document at `targetPath` for a restore in place or
 * onto an existing target, narrating it with progress events: `complete` is
 * sent from a `finally`, or a client overlay can stay locked forever. A past
 * that breaks a limit is refused before anything is written, and the record is
 * dropped as for any failure here.
 */
async function writePast(
  ctx: RestoreContext,
  targetPath: string,
  options: {
    label: string | undefined
    kind: DocumentKind | null
    /** The kind the target will record once saved, which the past envelope is held to. */
    recorded: DocumentKind | null
    /** Whether the answer carries the size of the restored document. */
    countElements?: boolean
  },
): Promise<Written | null> {
  const { deps, workspaceId, past, pastBytes, progress } = ctx
  const { label, kind, recorded, countElements } = options
  await progress({
    workspaceId,
    path: targetPath,
    phase: 'started',
    ...(label === undefined ? {} : { label }),
  })
  try {
    try {
      await withinSyncLimits(past, targetPath, recorded)
    } catch (err) {
      deps.workspaceDocuments.evict(workspaceId)
      throw err
    }
    return await writePastAtNode(deps, workspaceId, targetPath, pastBytes, kind, countElements)
  } finally {
    await progress({ workspaceId, path: targetPath, phase: 'complete' })
  }
}
