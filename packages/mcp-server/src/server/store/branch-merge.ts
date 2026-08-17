import { LoroDoc } from 'loro-crdt'
import type { MergeBadge } from '../../shared/merge-engine.js'
import { detectMergeBadges, meetVersion, toElementMap } from '../../shared/merge-engine.js'
import { checkoutCloneOrThrow, decodeBranchTipOrThrow } from '../app-helpers.js'
import { getLogger } from '../log.js'
import {
  BranchNotFoundError,
  deleteBranch,
  loadCanvasBranches,
  setHead as setHeadPersist,
  updateBranchTip,
} from './branches-store.js'
import { getDoc } from './doc-cache.js'
import { saveDocument } from './document-store.js'
import type { VersionStore } from './version-store.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

export interface PerformBranchMergeDeps {
  versionStore: VersionStore
  broadcastLoroUpdate: (workspaceId: string, path: string, update: Uint8Array) => void
  sendHeadChanged: (workspaceId: string, path: string, head: string) => void
}

export interface PerformBranchMergeArgs {
  source: string
  into: string
  dryRun: boolean
}

// The wire-safe shape routes/branches.ts's pluggable `performMerge` hook
// expects: routes/branches.ts only forwards these fields into the JSON
// response and never reads a badge's discriminant, so its contract stays
// structurally loose (any implementation, not just this one, can satisfy
// it) instead of hand-duplicating this file's stricter shape. Declared here
// — not in branches.ts — because this file is the one production caller;
// branches.ts imports the type rather than re-declaring it by hand, so the
// two cannot silently drift the way a second hand-written interface would.
export type PerformMergeHookResult = {
  previewElementCount: number
  // Optional target/source counts for the three MergeDialog columns.
  targetElementCount?: number
  sourceElementCount?: number
  badges: Array<Record<string, unknown>>
  committed: boolean
  // For dry runs, include alive elements so MergeDialog can render a read-only preview.
  previewElements?: unknown[]
  // Element ids for post-merge UI highlighting.
  newElementIds?: string[]
  changedElementIds?: string[]
  conflictElementIds?: string[]
  // Version id of the pre-merge snapshot used for undo after commit.
  preMergeVersionId?: string
  // Post-merge cleanup metadata.
  switchedHead?: { from: string; to: string }
  deletedSource?: string
}

// performBranchMerge always fills target/source counts and returns typed
// badges, so its own return type narrows the hook contract above rather
// than repeating it.
export interface PerformBranchMergeResult extends PerformMergeHookResult {
  targetElementCount: number
  sourceElementCount: number
  badges: MergeBadge[]
}

// Merge source into target.
// (1) clone the live snapshot
// (2) build a preview checked out to the target tipFrontiers
// (3) detect LWW edge cases with detectMergeBadges
// (4) on commit, update target tipFrontiers to source and, if target is HEAD,
//     reconcile the live doc to the preview and broadcast the change
// The whole read-modify-write (branch lookup, live-doc read, the
// pre-merge snapshot, the tip/HEAD writes, and their doc
// reconcile+save) runs inside one workspace-lock hold. getDoc(sid,
// path) alone is unlocked, so a concurrent rename/delete that runs
// its whole lock-protected section between this unlocked read and
// the later saveDocument() calls below would find no row left at
// this path and silently insert a phantom canvas (or resurrect
// deleted content) instead of erroring or landing on the renamed
// row. updateBranchTip/setHeadPersist/deleteBranch already acquire
// this same per-workspace lock internally (branches-store.ts), so
// they re-enter via the AsyncLocalStorage chain rather than
// deadlocking — mirrors live-doc.ts's POST /update handler.
export function performBranchMerge(
  deps: PerformBranchMergeDeps,
  sid: string,
  path: string,
  { source, into, dryRun }: PerformBranchMergeArgs,
): Promise<PerformBranchMergeResult> {
  const { versionStore, broadcastLoroUpdate, sendHeadChanged } = deps
  return withWorkspaceWriteLock(sid, async () => {
    const state = await loadCanvasBranches(sid, path)
    const sourceBranch = state.branches.find((b) => b.name === source)
    const intoBranch = state.branches.find((b) => b.name === into)
    if (!sourceBranch) {
      throw new BranchNotFoundError(`Branch "${source}" not found on ${sid}/${path}`)
    }
    if (!intoBranch) {
      throw new BranchNotFoundError(`Branch "${into}" not found on ${sid}/${path}`)
    }

    const sourceTip = sourceBranch.tipFrontiers
    const intoTip = intoBranch.tipFrontiers
    const liveDoc = await getDoc(sid, path)

    const cloneAt = (branchName: string, tipBase64: string): LoroDoc => {
      if (tipBase64.length === 0) {
        return LoroDoc.fromSnapshot(liveDoc.export({ mode: 'snapshot' }))
      }
      const frontiers = decodeBranchTipOrThrow(sid, path, branchName, tipBase64)
      return checkoutCloneOrThrow(
        liveDoc,
        frontiers,
        `${sid}/branches/${path}.json#${branchName}.tipFrontiers`,
        `branch "${branchName}" tipFrontiers could not be checked out against the live document`,
      )
    }

    const targetDoc = cloneAt(into, intoTip ?? '')
    const sourceDoc = cloneAt(source, sourceTip ?? '')
    // Use sourceDoc as the preview representation. Building a fully merged preview
    // safely would require a snapshot containing the full op-log after combining
    // target and source frontiers. In practice, sourceDoc closely matches the merge
    // result for the current "source wins" flow, and detectMergeBadges only needs a
    // stable target/source/preview triple to surface LWW differences.
    const previewDoc = sourceDoc

    // The merge base is the common ancestor: the per-peer minimum
    // ("meet") of target's and source's version vectors, checked out
    // against the live doc's full history. An all-omitted (empty) meet
    // checks out to genesis, which correctly classifies every source
    // element as new rather than resurrected.
    const baseFrontiers = liveDoc.vvToFrontiers(
      meetVersion(targetDoc.version(), sourceDoc.version()),
    )
    const baseDoc = checkoutCloneOrThrow(
      liveDoc,
      baseFrontiers,
      `${sid}/branches/${path}.json#merge-base`,
      'merge base could not be checked out against the live document',
    )

    const badges = detectMergeBadges({
      base: baseDoc,
      target: targetDoc,
      source: sourceDoc,
      preview: previewDoc,
    })

    // Diff elements between target and preview so the UI can highlight
    // new / changed / conflict elements after commit.
    const tMap = toElementMap(targetDoc)
    const pMap = toElementMap(previewDoc)
    const newElementIds: string[] = []
    const changedElementIds: string[] = []
    for (const [id, pEl] of pMap) {
      const tEl = tMap.get(id)
      if (!tEl) {
        newElementIds.push(id)
      } else if (JSON.stringify(pEl) !== JSON.stringify(tEl)) {
        changedElementIds.push(id)
      }
    }
    const conflictElementIds = Array.from(new Set(badges.map((b) => b.elementId)))

    // Counts come from the same nodes+edges map toElementMap builds for
    // previewElements/newElementIds/changedElementIds above, so
    // previewElementCount stays equal to previewElements.length (and the
    // other counts stay consistent) for a canvas containing edges.
    // countAliveNodes is deliberately not used here: it is a nodes-only
    // reader written for an unrelated advisory-count consumer.
    const previewElementCount = pMap.size
    const targetElementCount = tMap.size
    // previewDoc is sourceDoc (see above), so this mirrors previewElementCount exactly.
    const sourceElementCount = pMap.size

    if (dryRun) {
      // For dry runs, return every current node + edge so MergeDialog can
      // render a read-only preview. Payload shape is deliberately the
      // nodes-model equivalent of the retired Excalidraw-style elements
      // list; the field stays untyped (z.array(z.unknown())) because no
      // consumer reads element field contents today — MergeDialog only
      // reads .length, kept available for a future static renderer.
      const previewElements = [...pMap.values()]
      return {
        previewElementCount,
        targetElementCount,
        sourceElementCount,
        badges,
        committed: false,
        previewElements,
      }
    }

    // Capture a "before merge" version so the UI can offer undo by restoring it.
    // This is most useful when HEAD points at the target, but saving it uniformly
    // keeps the UI behavior consistent.
    let preMergeVersionId: string | undefined
    try {
      const beforeVersion = await versionStore.save(sid, path, liveDoc, {
        auto: true,
        label: `before merge: ${source} → ${into}`,
        branchName: into,
        operator: {
          kind: 'system',
          peerId: liveDoc.peerIdStr,
          displayName: 'merge',
        },
      })
      preMergeVersionId = beforeVersion.id
    } catch (err) {
      // Snapshot failure should not block the merge itself.
      getLogger('merge').warning(
        { workspaceId: sid, path, err: err as Error },
        'pre-merge snapshot failed',
      )
    }

    // Reconcile the live doc to the preview, persist it, and broadcast the
    // (possibly empty) delta. Shared by the HEAD===into commit path and the
    // HEAD===source cleanup path below.
    const reconcileLiveDocToPreview = async () => {
      const prevVV = liveDoc.version()
      liveDoc.import(previewDoc.export({ mode: 'snapshot' }))
      liveDoc.commit()
      await saveDocument(sid, path, liveDoc, { overwrite: true })
      const update = liveDoc.export({ mode: 'update', from: prevVV }) as Uint8Array
      if (update.byteLength > 0) {
        broadcastLoroUpdate(sid, path, update)
      }
    }

    // Commit by moving the target tipFrontiers to the source tip, unless the source
    // branch is still uninitialized.
    if (typeof sourceTip === 'string' && sourceTip.length > 0) {
      await updateBranchTip(sid, path, into, sourceTip)
    }

    // If the target is HEAD, reconcile and broadcast the live doc. Otherwise only
    // rewrite the stored tip.
    const latest = await loadCanvasBranches(sid, path)
    if (latest.head === into && sourceTip && sourceTip.length > 0) {
      await reconcileLiveDocToPreview()
      sendHeadChanged(sid, path, into)
    }

    // Post-merge cleanup:
    // 1) if HEAD still points at source, move it to target so the user sees the result
    // 2) delete the source branch unless it is main or the same as target
    // Cleanup failures only produce warnings; the merge still succeeds.
    let switchedHead: { from: string; to: string } | undefined
    let deletedSource: string | undefined
    try {
      const afterCommit = await loadCanvasBranches(sid, path)
      if (afterCommit.head === source && source !== into) {
        await setHeadPersist(sid, path, into)
        switchedHead = { from: source, to: into }
        sendHeadChanged(sid, path, into)
        // Already done when HEAD===target, but HEAD===source needs it here.
        await reconcileLiveDocToPreview()
      }
    } catch (err) {
      getLogger('merge').warning(
        { workspaceId: sid, path, err: err as Error },
        'post-merge head switch failed',
      )
    }
    if (source !== 'main' && source !== into) {
      try {
        await deleteBranch(sid, path, source)
        deletedSource = source
      } catch (err) {
        // For example: still HEAD, already deleted, and similar cleanup races.
        getLogger('merge').warning(
          { workspaceId: sid, path, err: err as Error },
          'post-merge delete source failed',
        )
      }
    }

    return {
      previewElementCount,
      targetElementCount,
      sourceElementCount,
      badges,
      committed: true,
      newElementIds,
      changedElementIds,
      conflictElementIds,
      preMergeVersionId,
      switchedHead,
      deletedSource,
    }
  })
}
