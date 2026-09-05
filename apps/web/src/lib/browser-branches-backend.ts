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
  planMerge,
  readBranchesFromRecord,
  renameBranch as renameBranchOp,
  setHead as setHeadOp,
  writeBranchesToRecord,
} from '@kamiazya/whiteboard-history'
import {
  projectWorkspaceDocument,
  readDocumentKind,
  readMarkdownBody,
  readSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import type { BranchesBackend } from './branches-backend.js'
import { BranchesUnsupportedError } from './branches-backend.js'
import type { BrowserBackend } from './browser-backend.js'

/** The state a document has when its record has not been delivered yet. */
const RESTING: DocumentBranchesState = {
  branches: [{ name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '' }],
  head: 'main',
}

export function createBrowserBranchesBackend(deps: {
  readonly backend: BrowserBackend
}): BranchesBackend {
  const read = (): DocumentBranchesState =>
    deps.backend.readRecord((doc, documentId) => readBranchesFromRecord(doc, documentId)) ?? RESTING

  /**
   * One branch operation: read the state, run the pure step, write what it
   * answers. `next: null` means the step changed nothing, and then nothing is
   * written — which is what keeps a no-op `setHead` from appending an op.
   */
  const mutate = <T>(
    step: (state: DocumentBranchesState) => { next: DocumentBranchesState | null; result: T },
  ): Promise<T> =>
    deps.backend.mutateRecord((doc, documentId) => {
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
    deps.backend.readRecord((doc, documentId) => {
      const clone = new LoroDoc()
      clone.import(doc.export({ mode: 'snapshot' }))
      return { clone, documentId }
    })

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
    hasBranches: true,

    async list() {
      return read()
    },

    async create(_workspaceId, _path, args): Promise<BranchMeta> {
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
      return mutate((state) => deleteBranchOp(state, scope, name))
    },

    async rename(_workspaceId, _path, oldName, newName) {
      const branch = await mutate((state) => renameBranchOp(state, scope, oldName, newName))
      // No version rows carry a branch name in this keeper yet, so a rename
      // renames nothing else. Reported as zero rather than omitted: the field
      // is the count of what moved, and zero is the true count.
      return { branch, renamedVersionCount: 0 }
    },

    async setHead(_workspaceId, _path, branch) {
      return mutate((state) => setHeadOp(state, scope, branch))
    },

    async getStats(_workspaceId, _path, name) {
      const state = read()
      // `unmergedCommits` is zero for the same reason the daemon answers zero:
      // tip adoption has no commit count to report, and a number invented here
      // would read as a measurement.
      return { unmergedCommits: 0, isHead: state.head === name }
    },

    async merge(_workspaceId, _path, source, args) {
      if (args.dryRun !== true) {
        throw new BranchesUnsupportedError('committing a merge is not implemented in the browser')
      }
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
      return {
        badges: plan.badges as unknown as Record<string, unknown>[],
        preview: { elementCount: plan.previewElementCount },
        target: { elementCount: plan.targetElementCount },
        source: { elementCount: plan.sourceElementCount },
        previewElements: plan.previewElements,
        newElementIds: plan.newElementIds,
        changedElementIds: plan.changedElementIds,
        conflictElementIds: plan.conflictElementIds,
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
