import type { DocumentBranchesState } from '@kamiazya/whiteboard-daemon-client/api-contracts/branches'
import {
  type BranchMeta,
  type BranchScope,
  createBranch as createBranchOp,
  DEFAULT_MAIN_COLOR,
  defaultMain,
  deleteBranch as deleteBranchOp,
  renameBranch as renameBranchOp,
  resolveHead,
  setHead as setHeadOp,
  updateBranchTip as updateBranchTipOp,
} from '@kamiazya/whiteboard-history'
import {
  resolveWorkspaceDocument,
  resolveWorkspaceDocumentById,
  updateWorkspaceDocumentMeta,
} from '@kamiazya/whiteboard-loro-adapter'
import { getDataDir } from '../config.js'
import { getLogger } from '../log.js'
import { validateBranchName, validateDocumentPath, validateWorkspaceId } from '../validators.js'
import { getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'
import { DocumentNotFoundError } from './document-not-found-error.js'
import { openWorkspaceDocIfStored, saveWorkspaceDoc } from './document-store.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

// Canvas-scoped branch state. Backed by:
//   branches table         -> one row per branch keyed on (documentId, name)
//   documents.currentBranch -> HEAD pointer per canvas row
//
// What a branch IS, and every rule about changing one (no duplicate names,
// `main` immovable, HEAD undeletable, a rename follows HEAD and every
// `baseBranch` that named it) is `@kamiazya/whiteboard-history`'s: this
// module is the daemon's read-modify-write around those pure steps — the
// per-workspace lock, the rows, the HEAD mirror into the record.
//
// All accessors take (workspaceId, path) so the public API stays stable
// across the path → documentId migration. Internally the path is resolved to
// the stable canvas id before any branches/documents write.

export type { BranchMeta } from '@kamiazya/whiteboard-daemon-client/api-contracts/branches'
export {
  BranchConflictError,
  BranchNotFoundError,
  DEFAULT_MAIN_COLOR,
} from '@kamiazya/whiteboard-history'

// Internal alias: this store's DocumentBranches predates the shared contract
// and its callers already spell that name — kept to avoid a same-package
// drive-by rename beyond this increment's scope.
export type DocumentBranches = DocumentBranchesState

async function dbReady() {
  await prepareDataDir(getDataDir())
  return getDb(getDataDir())
}

export async function loadDocumentBranches(
  workspaceId: string,
  path: string,
): Promise<DocumentBranches> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  const db = await dbReady()
  // The document and its HEAD resolve from the workspace record (S7); the
  // branch ROWS stay in sqlite, keyed by the id the tree answers.
  const target = await resolveDocumentForBranches(workspaceId, path)
  if (target === null) {
    return { branches: [defaultMain()], head: 'main' }
  }
  const branchRows = await db
    .selectFrom('branches')
    .select(['name', 'tipFrontiers', 'sourceBranchName', 'sourceVersionId', 'color', 'createdAt'])
    .where('documentId', '=', target.documentId)
    .orderBy('createdAt', 'asc')
    .orderBy('name', 'asc')
    .execute()
  if (branchRows.length === 0) {
    return { branches: [defaultMain()], head: 'main' }
  }
  const branches: BranchMeta[] = branchRows.map((r) => ({
    name: r.name,
    tipFrontiers: r.tipFrontiers,
    color: r.color ?? DEFAULT_MAIN_COLOR,
    createdAt: new Date(r.createdAt).toISOString(),
    ...(r.sourceBranchName !== null ? { baseBranch: r.sourceBranchName } : {}),
    ...(r.sourceVersionId !== null ? { baseVersionId: r.sourceVersionId } : {}),
  }))
  return { branches, head: resolveHead(branches, target.currentBranch) }
}

/** The documentId + HEAD for a path, answered from the workspace tree; null when the tree does not serve it. */
async function resolveDocumentForBranches(
  workspaceId: string,
  path: string,
): Promise<{ documentId: string; currentBranch?: string } | null> {
  const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
  if (workspaceDoc === null) return null
  const entry = resolveWorkspaceDocument(workspaceDoc, path)
  if (entry === null) return null
  return {
    documentId: entry.documentId,
    ...(entry.currentBranch === undefined ? {} : { currentBranch: entry.currentBranch }),
  }
}

// The actual write, assuming the workspace write lock is already held by
// the caller. Never call this directly from outside this module — always
// go through saveDocumentBranches() or mutateDocumentBranches() so the lock is
// guaranteed.
async function saveDocumentBranchesLocked(
  workspaceId: string,
  path: string,
  state: DocumentBranches,
): Promise<void> {
  for (const branch of state.branches) {
    validateBranchName(branch.name)
  }
  validateBranchName(state.head)
  const db = await dbReady()
  const target = await resolveDocumentForBranches(workspaceId, path)
  if (target === null) throw new DocumentNotFoundError(workspaceId, path)
  const documentId = target.documentId
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('branches').where('documentId', '=', documentId).execute()
    if (state.branches.length > 0) {
      await trx
        .insertInto('branches')
        .values(
          state.branches.map((b) => ({
            documentId,
            workspaceId,
            name: b.name,
            tipFrontiers: b.tipFrontiers,
            color: b.color ?? null,
            sourceBranchName: b.baseBranch ?? null,
            sourceVersionId: b.baseVersionId ?? null,
            createdAt: parseIsoOrNow(b.createdAt),
          })),
        )
        .execute()
    }
  })
  // Mirror the HEAD into the workspace record's node meta (dual-plane
  // collapse S4b): shared CRDT state every replica converges on, while the
  // row column keeps serving today's reads. Guarded by a read so a tip-only
  // save does not append a same-value op per save. Fail-soft while the row
  // is what reads serve: a mirror hiccup must not fail a branch write that
  // already durably committed.
  try {
    const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
    if (workspaceDoc !== null) {
      const entry = resolveWorkspaceDocumentById(workspaceDoc, documentId)
      if (entry !== null && (entry.currentBranch ?? 'main') !== state.head) {
        updateWorkspaceDocumentMeta(workspaceDoc, documentId, { currentBranch: state.head })
        await saveWorkspaceDoc(workspaceId, workspaceDoc)
      }
    }
  } catch (err) {
    getLogger('branches-store').warning(
      { workspaceId, path, err },
      'failed to mirror branch HEAD into the workspace record',
    )
  }
}

// Every branch mutation (createBranch, deleteBranch, updateBranchTip,
// setHead, renameBranch) funnels through this single write path, so
// taking the per-workspace write lock here — rather than in each caller —
// closes the GC-vs-branch-write race for all of them at once: file-gc's
// collect-then-unlink pass (purgeDanglingFiles) also holds this lock, so a
// branch tip can never be created/updated between GC's snapshot of
// referenced fileIds and its unlink pass.
export async function saveDocumentBranches(
  workspaceId: string,
  path: string,
  state: DocumentBranches,
): Promise<void> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  await withWorkspaceWriteLock(workspaceId, () =>
    saveDocumentBranchesLocked(workspaceId, path, state),
  )
}

// Read-modify-write helper for every mutator below (createBranch,
// deleteBranch, setHead, renameBranch, updateBranchTip). The read
// (loadDocumentBranches) and the write (saveDocumentBranchesLocked) must
// happen inside the SAME lock acquisition — acquiring the lock only
// around the final write (as saveDocumentBranches did on its own) leaves a
// window between the read and the write where file-gc's collect-then-
// unlink pass can acquire the lock, snapshot the pre-mutation branch
// state, and delete a file that `mutate`'s computed next state is about
// to start referencing.
//
// `mutate` returns `next: null` to signal "no write needed" (e.g. setHead
// to the branch that is already HEAD). See withDocumentBranchesLock below for
// the async-callback variant used by callers that must await external work
// (e.g. a doc checkout) between the read and the write.
async function mutateDocumentBranches<T>(
  workspaceId: string,
  path: string,
  mutate: (state: DocumentBranches) => { next: DocumentBranches | null; result: T },
): Promise<T> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  return withWorkspaceWriteLock(workspaceId, async () => {
    const state = await loadDocumentBranches(workspaceId, path)
    const { next, result } = mutate(state)
    if (next) {
      await saveDocumentBranchesLocked(workspaceId, path, next)
    }
    return result
  })
}

// Lock-spanning helper for callers whose read-modify-write needs to
// interleave AWAITED external work (e.g. routes/branches.ts's PUT /head,
// which must capture the outgoing HEAD's live frontiers and reconcile the
// live doc to the new tip before persisting the updated branch state).
// mutateDocumentBranches's `mutate` callback is synchronous by design and
// cannot express that shape, so this exposes the same load + a `save`
// bound to the same per-workspace lock: everything the caller does inside
// `fn`, including its own awaits, runs while holding the lock, so
// file-gc's collect-then-unlink pass cannot observe a state where the
// live doc has already moved to the new HEAD but the outgoing branch's
// tipFrontiers has not been persisted yet.
export async function withDocumentBranchesLock<T>(
  workspaceId: string,
  path: string,
  fn: (state: DocumentBranches, save: (next: DocumentBranches) => Promise<void>) => Promise<T>,
): Promise<T> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  return withWorkspaceWriteLock(workspaceId, async () => {
    const state = await loadDocumentBranches(workspaceId, path)
    return fn(state, (next) => saveDocumentBranchesLocked(workspaceId, path, next))
  })
}

function parseIsoOrNow(iso: string): number {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : Date.now()
}

function scopeOf(workspaceId: string, path: string): BranchScope {
  return { workspaceId, path }
}

export async function createBranch(
  workspaceId: string,
  path: string,
  opts: {
    name: string
    initialTipFrontiers?: string
    baseBranch?: string
    baseVersionId?: string
    color?: string
  },
): Promise<BranchMeta> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  validateBranchName(opts.name)
  return mutateDocumentBranches(workspaceId, path, (state) =>
    createBranchOp(state, scopeOf(workspaceId, path), opts),
  )
}

export async function deleteBranch(
  workspaceId: string,
  path: string,
  name: string,
): Promise<{ ok: true; unmergedCommits: number }> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  validateBranchName(name)
  // The `main` refusal is the mechanic's, but it is answered before the
  // lock is taken and the rows are read, as it always was here.
  if (name === 'main') {
    deleteBranchOp({ branches: [], head: 'main' }, scopeOf(workspaceId, path), name)
  }
  return mutateDocumentBranches(workspaceId, path, (state) =>
    deleteBranchOp(state, scopeOf(workspaceId, path), name),
  )
}

export async function setHead(
  workspaceId: string,
  path: string,
  name: string,
): Promise<{ head: string; previousHead: string }> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  validateBranchName(name)
  return mutateDocumentBranches(workspaceId, path, (state) =>
    setHeadOp(state, scopeOf(workspaceId, path), name),
  )
}

export async function renameBranch(
  workspaceId: string,
  path: string,
  oldName: string,
  newName: string,
): Promise<BranchMeta> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  validateBranchName(oldName)
  validateBranchName(newName)
  if (oldName === 'main') {
    renameBranchOp({ branches: [], head: 'main' }, scopeOf(workspaceId, path), oldName, newName)
  }
  return mutateDocumentBranches(workspaceId, path, (state) =>
    renameBranchOp(state, scopeOf(workspaceId, path), oldName, newName),
  )
}

export async function getBranchTipBase64(
  workspaceId: string,
  path: string,
  name: string,
): Promise<string | null> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  validateBranchName(name)
  const state = await loadDocumentBranches(workspaceId, path)
  const branch = state.branches.find((b) => b.name === name)
  return branch ? branch.tipFrontiers : null
}

export async function updateBranchTip(
  workspaceId: string,
  path: string,
  name: string,
  tipFrontiers: string,
): Promise<void> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  validateBranchName(name)
  await mutateDocumentBranches(workspaceId, path, (state) =>
    updateBranchTipOp(state, scopeOf(workspaceId, path), name, tipFrontiers),
  )
}
