/**
 * Everything a merge decides BEFORE anything is written, as one pure step.
 *
 * The shipped merge is tip adoption, "source wins": committing moves the
 * target's tip to the source's, and where the target is HEAD the live
 * document is reconciled to that tip. What that leaves to plan is the
 * preview and the advisories — which elements arrive new or changed, which
 * a person should look at (`detectMergeBadges`), and the counts the dialog's
 * three columns show. All of it is projections of the workspace record at
 * three frontiers (target tip, source tip, and their common ancestor), so
 * it needs the record and nothing else: no lock, no row, no route. A keeper
 * runs it inside whatever it holds for the commit that may follow.
 *
 * The per-document fallback — a document the fold could not move onto the
 * record, whose tips were recorded against its own oplog — survives only for
 * that damaged remnant, and `liveDoc` is what it is checked out against.
 */
import { projectWorkspaceDocument } from '@kamiazya/whiteboard-loro-adapter'
import { type Frontiers, LoroDoc } from 'loro-crdt'
import { frontiersFromBase64 } from '../frontiers-base64.js'
import { detectMergeBadges, type MergeBadge, meetVersion, toElementMap } from './merge-engine.js'

export interface MergePlanInput {
  /**
   * A CLONE of the workspace record (the caller exports and re-imports its
   * snapshot; checking out moves the clone, never the record), or null when
   * the record does not hold this document.
   */
  readonly workspaceRecord: LoroDoc | null
  /** The document's id within the record; ignored when the record is null. */
  readonly documentId: string | null
  /** The live document: the fallback lineage, and what an empty tip means. */
  readonly liveDoc: LoroDoc
  readonly into: { readonly name: string; readonly tipFrontiers: string }
  readonly source: { readonly name: string; readonly tipFrontiers: string }
}

export interface MergePlan {
  readonly badges: MergeBadge[]
  readonly newElementIds: string[]
  readonly changedElementIds: string[]
  readonly conflictElementIds: string[]
  readonly previewElementCount: number
  readonly targetElementCount: number
  readonly sourceElementCount: number
  /** Every alive node and edge of the preview, for a read-only render. */
  readonly previewElements: unknown[]
  /** The document the target becomes on commit — the source tip, under tip adoption. */
  readonly previewDoc: LoroDoc
}

/**
 * A recorded tip that cannot be read or checked out: stored data the keeper
 * holds is inconsistent with the record it points into. Typed so a keeper
 * can answer its caller as corruption rather than as a merge that failed.
 */
export class UnreadableBranchTipError extends Error {
  constructor(
    readonly branchLabel: string,
    readonly detail: string,
  ) {
    super(`branch "${branchLabel}": ${detail}`)
    this.name = 'UnreadableBranchTipError'
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error'
}

function decodeTip(branchLabel: string, tipBase64: string): Frontiers {
  try {
    return frontiersFromBase64(tipBase64)
  } catch (err) {
    throw new UnreadableBranchTipError(
      branchLabel,
      `tipFrontiers could not be decoded (${messageOf(err)})`,
    )
  }
}

export function planMerge(input: MergePlanInput): MergePlan {
  const { workspaceRecord, documentId, liveDoc, into, source } = input
  const onRecord = workspaceRecord !== null && documentId !== null

  // A tree-served document's branch tips are recorded against the WORKSPACE
  // record's oplog: they are checked out on a clone of that record and the
  // document is PROJECTED at that point. A projection that answers null means
  // the document did not exist at that point of history — an empty doc is
  // the honest value there.
  const projectAtRecordFrontiers = (branchLabel: string, frontiers: Frontiers): LoroDoc => {
    const at = LoroDoc.fromSnapshot((workspaceRecord as LoroDoc).export({ mode: 'snapshot' }))
    try {
      at.checkout(frontiers)
    } catch (err) {
      throw new UnreadableBranchTipError(
        branchLabel,
        `tipFrontiers could not be checked out against the workspace record (${messageOf(err)})`,
      )
    }
    return projectWorkspaceDocument(at, documentId as string) ?? new LoroDoc()
  }

  const checkoutLiveClone = (
    branchLabel: string,
    frontiers: Frontiers,
    detail: string,
  ): LoroDoc => {
    const clone = LoroDoc.fromSnapshot(liveDoc.export({ mode: 'snapshot' }))
    try {
      clone.checkout(frontiers)
    } catch (err) {
      throw new UnreadableBranchTipError(branchLabel, `${detail} (${messageOf(err)})`)
    }
    return clone
  }

  const cloneAt = (branchLabel: string, tipBase64: string): LoroDoc => {
    if (tipBase64.length === 0) {
      return LoroDoc.fromSnapshot(liveDoc.export({ mode: 'snapshot' }))
    }
    const frontiers = decodeTip(branchLabel, tipBase64)
    if (onRecord) return projectAtRecordFrontiers(branchLabel, frontiers)
    return checkoutLiveClone(
      branchLabel,
      frontiers,
      'tipFrontiers could not be checked out against the live document',
    )
  }

  const targetDoc = cloneAt(into.name, into.tipFrontiers)
  const sourceDoc = cloneAt(source.name, source.tipFrontiers)
  // The source tip IS the preview under tip adoption. Building a fully merged
  // preview would need a snapshot holding the full op-log after combining
  // both frontiers; the badges only need a stable target/source/preview
  // triple to surface the surprising outcomes.
  const previewDoc = sourceDoc

  // The merge base is the common ancestor: the per-peer minimum ("meet") of
  // the two tips' version vectors. For a document on the record, the only
  // lineage the tips share is the RECORD's — each projection above mints its
  // own — so the meet is taken there and the base projected at it. An empty
  // meet checks out to genesis, which classifies every source element as new
  // rather than resurrected.
  let baseDoc: LoroDoc
  if (onRecord) {
    const record = workspaceRecord as LoroDoc
    const tipVV = (tipBase64: string, branchLabel: string) =>
      tipBase64.length > 0
        ? record.frontiersToVV(decodeTip(branchLabel, tipBase64))
        : record.version()
    const baseFrontiers = record.vvToFrontiers(
      meetVersion(tipVV(into.tipFrontiers, into.name), tipVV(source.tipFrontiers, source.name)),
    )
    baseDoc = projectAtRecordFrontiers('merge-base', baseFrontiers)
  } else {
    const baseFrontiers = liveDoc.vvToFrontiers(
      meetVersion(targetDoc.version(), sourceDoc.version()),
    )
    baseDoc = checkoutLiveClone(
      'merge-base',
      baseFrontiers,
      'merge base could not be checked out against the live document',
    )
  }

  const badges = detectMergeBadges({
    base: baseDoc,
    target: targetDoc,
    source: sourceDoc,
    preview: previewDoc,
  })

  // Diff target against preview so the surface can highlight what arrives
  // new or changed once the merge lands.
  const tMap = toElementMap(targetDoc)
  const pMap = toElementMap(previewDoc)
  const newElementIds: string[] = []
  const changedElementIds: string[] = []
  for (const [id, pEl] of pMap) {
    const tEl = tMap.get(id)
    if (!tEl) newElementIds.push(id)
    else if (JSON.stringify(pEl) !== JSON.stringify(tEl)) changedElementIds.push(id)
  }

  return {
    badges,
    newElementIds,
    changedElementIds,
    conflictElementIds: Array.from(new Set(badges.map((b) => b.elementId))),
    // Counts come from the same nodes+edges map the ids above come from, so
    // they stay consistent with `previewElements.length` for a canvas
    // holding edges.
    previewElementCount: pMap.size,
    targetElementCount: tMap.size,
    // previewDoc is sourceDoc, so this mirrors previewElementCount exactly.
    sourceElementCount: pMap.size,
    previewElements: [...pMap.values()],
    previewDoc,
  }
}
