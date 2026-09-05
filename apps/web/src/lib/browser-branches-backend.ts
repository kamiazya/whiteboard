/**
 * The browser keeper's answer to the branches seam.
 *
 * A branch is a name and a frontier OF THE WORKSPACE RECORD, and this keeper
 * holds that record — so it needs no route, no row and no second schema. The
 * rules for changing one (no duplicate names, `main` immovable, HEAD
 * undeletable, a rename that follows HEAD and every `baseBranch` naming it)
 * are `@kamiazya/whiteboard-history`'s, the same functions the daemon runs;
 * what this module supplies is the read-modify-write around them, which here
 * is `BrowserBackend`'s write queue rather than the daemon's workspace lock.
 *
 * `workspaceId` is ignored in favour of the browser's own, for the reason
 * `createBrowserVersionsBackend` states: the top bar spells a display
 * placeholder there, and a branch must not be filed under a name that is not
 * a workspace.
 */
import {
  type BranchMeta,
  createBranch as createBranchOp,
  type DocumentBranchesState,
  deleteBranch as deleteBranchOp,
  frontiersFromBase64,
  MAIN_BRANCH,
  planMerge,
  readBranchesFromRecord,
  renameBranch as renameBranchOp,
  setHead as setHeadOp,
  updateBranchTip as updateBranchTipOp,
  writeBranchesToRecord,
} from '@kamiazya/whiteboard-history'
import {
  projectWorkspaceDocument,
  readDocumentKind,
  readMarkdownBody,
  readSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { getAppLogger } from './app-logger.js'
import type { BranchesBackend } from './branches-backend.js'
import { BranchesUnsupportedError } from './branches-backend.js'
import type { BrowserBackend } from './browser-backend.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'

const log = getAppLogger('browser-branches')

/** The one method of the version store a merge needs — narrowed so this module takes no store. */
type BrowserVersionSave = (
  workspaceId: string,
  path: string,
  options: {
    auto?: boolean
    label?: string
    branchName?: string
    operator?: { kind: 'system'; peerId: string; displayName: string }
  },
) => Promise<{ id: string }>

/** The state a document has when its record has not been delivered yet. */
const RESTING: DocumentBranchesState = {
  branches: [{ name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '' }],
  head: 'main',
}

/**
 * `backend` is nullable, and that is load-bearing rather than defensive.
 *
 * The browser page has no `BrowserBackend` for a markdown document — its body
 * is persisted by its own path — and none at all until the document loads. A
 * caller that answered `null` to the context in those cases would fall
 * through to the context's DAEMON fallback and start issuing requests to a
 * daemon that is not there, which is the single regression this provider was
 * mounted to prevent. So the browser keeper always answers, and says
 * truthfully that a document with no record-holding backend has no branches.
 */
export function createBrowserBranchesBackend(deps: {
  readonly backend: BrowserBackend | null
  /**
   * Where a pre-merge point is kept. Optional because a page can mount this
   * before its version store exists, and because a merge whose snapshot fails
   * still commits — the daemon treats that failure as a warning too, and a
   * merge that refused because a bookmark could not be written would be worse
   * than one nobody can rewind past.
   */
  readonly versions?: { save: BrowserVersionSave } | null
}): BranchesBackend {
  const backend = deps.backend
  const refuse = (what: string) => Promise.reject(new BranchesUnsupportedError(what))
  const read = (): DocumentBranchesState =>
    backend?.readRecord((doc, documentId) => readBranchesFromRecord(doc, documentId)) ?? RESTING

  /**
   * One branch operation: read the state, run the pure step, write what it
   * answers. `next: null` means the step changed nothing, and then nothing is
   * written — which is what keeps a no-op `setHead` from appending an op.
   */
  const mutate = <T>(
    step: (state: DocumentBranchesState) => { next: DocumentBranchesState | null; result: T },
  ): Promise<T> =>
    (backend as BrowserBackend).mutateRecord((doc, documentId) => {
      const { next, result } = step(readBranchesFromRecord(doc, documentId))
      if (next !== null) writeBranchesToRecord(doc, documentId, next)
      return result
    })

  /** Where a branch is, for the error messages the pure steps build. */
  const scope = { workspaceId: 'browser', path: '' }

  /**
   * A CLONE of the record, because reading a branch at its tip means checking
   * out a frontier and a checkout MOVES the document it is called on. The
   * clone is what moves; the live record the page is drawing does not.
   */
  const cloneRecord = (): { clone: LoroDoc; documentId: string } | null =>
    backend?.readRecord((doc, documentId) => {
      const clone = new LoroDoc()
      clone.import(doc.export({ mode: 'snapshot' }))
      return { clone, documentId }
    }) ?? null

  /** The document as one branch's tip has it, or null when there is no such branch. */
  const atTip = (name: string): LoroDoc | null => {
    const state = read()
    const branch = state.branches.find((b) => b.name === name)
    if (branch === undefined) return null
    const cloned = cloneRecord()
    if (cloned === null) return null
    // An empty tip is a branch nothing has written to: it names the document
    // as it stands, which is what the record already holds.
    if (branch.tipFrontiers.length > 0) {
      cloned.clone.checkout(frontiersFromBase64(branch.tipFrontiers))
    }
    return projectWorkspaceDocument(cloned.clone, cloned.documentId)
  }

  return {
    hasBranches: backend !== null,

    async list() {
      return read()
    },

    async create(_workspaceId, _path, args): Promise<BranchMeta> {
      if (backend === null) return refuse('create')
      return mutate((state) =>
        createBranchOp(state, scope, {
          name: args.name,
          ...(args.color === undefined ? {} : { color: args.color }),
          // The request calls it `fromVersionId`; a branch records it as
          // `baseVersionId`. One name for the wire, one for the stored shape,
          // and this is the single place they meet.
          ...(args.fromVersionId === undefined ? {} : { baseVersionId: args.fromVersionId }),
        }),
      )
    },

    async remove(_workspaceId, _path, name) {
      if (backend === null) return refuse('delete')
      return mutate((state) => deleteBranchOp(state, scope, name))
    },

    async rename(_workspaceId, _path, oldName, newName) {
      if (backend === null) return refuse('rename')
      const branch = await mutate((state) => renameBranchOp(state, scope, oldName, newName))
      // No version rows carry a branch name in this keeper yet, so a rename
      // renames nothing else. Reported as zero rather than omitted: the field
      // is the count of what moved, and zero is the true count.
      return { branch, renamedVersionCount: 0 }
    },

    async setHead(_workspaceId, _path, branch) {
      if (backend === null) return refuse('switch')
      return mutate((state) => setHeadOp(state, scope, branch))
    },

    async getStats(_workspaceId, _path, name) {
      if (backend === null) return refuse('stats')
      const state = read()
      // `unmergedCommits` is zero for the same reason the daemon answers zero:
      // tip adoption has no commit count to report, and a number invented here
      // would read as a measurement.
      return { unmergedCommits: 0, isHead: state.head === name }
    },

    async merge(_workspaceId, _path, source, args) {
      if (backend === null) return refuse('merge')
      const state = read()
      const into = state.branches.find((b) => b.name === args.into)
      const from = state.branches.find((b) => b.name === source)
      const cloned = cloneRecord()
      if (into === undefined || from === undefined || cloned === null) {
        throw new Error(`no such branch: ${into === undefined ? args.into : source}`)
      }
      const liveDoc = projectWorkspaceDocument(cloned.clone, cloned.documentId) ?? new LoroDoc()
      const plan = planMerge({
        workspaceRecord: cloned.clone,
        documentId: cloned.documentId,
        liveDoc,
        into: { name: into.name, tipFrontiers: into.tipFrontiers },
        source: { name: from.name, tipFrontiers: from.tipFrontiers },
      })
      const counts = {
        badges: plan.badges as unknown as Record<string, unknown>[],
        preview: { elementCount: plan.previewElementCount },
        target: { elementCount: plan.targetElementCount },
        source: { elementCount: plan.sourceElementCount },
        previewElements: plan.previewElements,
        newElementIds: plan.newElementIds,
        changedElementIds: plan.changedElementIds,
        conflictElementIds: plan.conflictElementIds,
      }
      if (args.dryRun === true) return counts

      // The same four steps the daemon commits in, in the same order, over
      // this keeper's storage instead of its own.

      // 1. The point before the merge, so it can be rewound past. Best effort
      //    for the reason `versions` is optional above.
      let preMergeVersionId: string | undefined
      try {
        const saved = await deps.versions?.save(getBrowserWorkspaceId(), _path, {
          auto: true,
          label: `before merge: ${source} → ${args.into}`,
          branchName: args.into,
          operator: { kind: 'system', peerId: 'browser', displayName: 'merge' },
        })
        preMergeVersionId = saved?.id
      } catch (err) {
        log.warn('pre-merge snapshot failed', err)
      }

      // 2. Tip adoption, which IS the merge: the target takes the source's
      //    tip. An uninitialised source has no tip to adopt and moves nothing.
      if (from.tipFrontiers.length > 0) {
        await mutate((s) => updateBranchTipOp(s, scope, args.into, from.tipFrontiers))
      }

      // 3. When the target is HEAD, the document itself becomes the preview.
      //    `writeWorkspaceDocumentContent` is a DIFF and never a rewrite — the
      //    same call `applyRestore` reconciles a past state with — so the ops
      //    it emits reach the sync session as a peer's would.
      const latest = read()
      if (latest.head === args.into && from.tipFrontiers.length > 0) {
        await backend.mutateRecord((doc, documentId) => {
          writeWorkspaceDocumentContent(doc, documentId, plan.previewDoc)
        })
      }

      // 4. Cleanup, warned about rather than fatal: the merge has committed
      //    by now, and failing here would report a merge that did not happen.
      let switchedHead: { from: string; to: string } | undefined
      let deletedSource: string | undefined
      try {
        const afterCommit = read()
        if (afterCommit.head === source && source !== args.into) {
          await mutate((s) => setHeadOp(s, scope, args.into))
          switchedHead = { from: source, to: args.into }
        }
      } catch (err) {
        log.warn('post-merge head switch failed', err)
      }
      if (source !== MAIN_BRANCH && source !== args.into) {
        try {
          await mutate((s) => deleteBranchOp(s, scope, source))
          deletedSource = source
        } catch (err) {
          log.warn('post-merge delete source failed', err)
        }
      }

      return {
        ...counts,
        committed: { elementCount: plan.previewElementCount },
        ...(preMergeVersionId === undefined ? {} : { preMergeVersionId }),
        ...(switchedHead === undefined ? {} : { switchedHead }),
        ...(deletedSource === undefined ? {} : { deletedSource }),
      }
    },

    async loadDocument(_workspaceId, _path, name) {
      const doc = atTip(name)
      if (doc === null) return null
      return readDocumentKind(doc) === 'markdown'
        ? { kind: 'markdown', body: readMarkdownBody(doc) }
        : { kind: 'spatial', canvas: readSpatialCanvas(doc) }
    },
  }
}
