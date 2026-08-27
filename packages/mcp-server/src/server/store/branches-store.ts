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
// All accessors take (workspaceId, path) so the public API stays stable
// across the path → documentId migration. Internally the path is resolved to
// the stable canvas id before any branches/documents write.

export interface BranchMeta {
  name: string
  tipFrontiers: string
  baseBranch?: string
  baseVersionId?: string
  color: string
  createdAt: string
}

export interface DocumentBranches {
  branches: BranchMeta[]
  head: string
}

export const DEFAULT_MAIN_COLOR = '#1971c2'

function defaultMain(): BranchMeta {
  return {
    name: 'main',
    tipFrontiers: '',
    color: DEFAULT_MAIN_COLOR,
    createdAt: new Date().toISOString(),
  }
}

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
  // branch ROWS stay in sqlite, keyed by the id the tree answers. The boot
  // fold carries a pre-fold row's HEAD into the tree before this can be
  // asked, so no rows fallback for the pointer is needed.
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
  const persistedHead = target.currentBranch ?? 'main'
  const head = branches.some((b) => b.name === persistedHead)
    ? persistedHead
    : branches.some((b) => b.name === 'main')
      ? 'main'
      : branches[0]!.name
  return { branches, head }
}

/**
 * The documentId + HEAD for a path: the tree answers when it holds the
 * document; a pre-fold legacy document (rows only) answers from its row so
 * branch state survives until the boot fold relocates it.
 */
async function resolveDocumentForBranches(
  workspaceId: string,
  path: string,
): Promise<{ documentId: string; currentBranch?: string } | null> {
  const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
  if (workspaceDoc !== null) {
    const entry = resolveWorkspaceDocument(workspaceDoc, path)
    if (entry !== null) {
      return {
        documentId: entry.documentId,
        ...(entry.currentBranch === undefined ? {} : { currentBranch: entry.currentBranch }),
      }
    }
  }
  const db = await dbReady()
  const row = await db
    .selectFrom('documents')
    .select(['id', 'currentBranch'])
    .where('workspaceId', '=', workspaceId)
    .where('path', '=', path)
    .executeTakeFirst()
  return row === undefined ? null : { documentId: row.id, currentBranch: row.currentBranch }
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

// Stable error names so callers can distinguish conflict vs not found.
export class BranchConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BranchConflictError'
  }
}
export class BranchNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BranchNotFoundError'
  }
}

const BRANCH_COLOR_PALETTE = ['#9333ea', '#2f9e44', '#e03131', '#f08c00', '#0c8599', '#e64980']

function nextColor(existing: BranchMeta[]): string {
  const used = new Set(existing.map((b) => b.color.toLowerCase()))
  for (const c of BRANCH_COLOR_PALETTE) {
    if (!used.has(c.toLowerCase())) return c
  }
  return BRANCH_COLOR_PALETTE[existing.length % BRANCH_COLOR_PALETTE.length]!
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

  return mutateDocumentBranches(workspaceId, path, (state) => {
    if (state.branches.some((b) => b.name === opts.name)) {
      throw new BranchConflictError(
        `Branch "${opts.name}" already exists on ${workspaceId}/${path}`,
      )
    }
    const branch: BranchMeta = {
      name: opts.name,
      tipFrontiers: opts.initialTipFrontiers ?? '',
      color: opts.color ?? nextColor(state.branches),
      createdAt: new Date().toISOString(),
      ...(opts.baseBranch !== undefined ? { baseBranch: opts.baseBranch } : {}),
      ...(opts.baseVersionId !== undefined ? { baseVersionId: opts.baseVersionId } : {}),
    }
    const next: DocumentBranches = { ...state, branches: [...state.branches, branch] }
    return { next, result: branch }
  })
}

export async function deleteBranch(
  workspaceId: string,
  path: string,
  name: string,
): Promise<{ ok: true; unmergedCommits: number }> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  validateBranchName(name)
  if (name === 'main') {
    throw new BranchConflictError('Cannot delete main branch')
  }
  return mutateDocumentBranches(workspaceId, path, (state) => {
    if (!state.branches.some((b) => b.name === name)) {
      throw new BranchNotFoundError(`Branch "${name}" not found on ${workspaceId}/${path}`)
    }
    if (state.head === name) {
      throw new BranchConflictError(
        `Cannot delete branch "${name}" while it is HEAD. setHead to another branch first.`,
      )
    }
    const next: DocumentBranches = {
      ...state,
      branches: state.branches.filter((b) => b.name !== name),
    }
    return { next, result: { ok: true as const, unmergedCommits: 0 } }
  })
}

export async function setHead(
  workspaceId: string,
  path: string,
  name: string,
): Promise<{ head: string; previousHead: string }> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  validateBranchName(name)
  return mutateDocumentBranches(workspaceId, path, (state) => {
    if (!state.branches.some((b) => b.name === name)) {
      throw new BranchNotFoundError(`Branch "${name}" not found on ${workspaceId}/${path}`)
    }
    const previousHead = state.head
    if (previousHead === name) {
      return { next: null, result: { head: name, previousHead } }
    }
    return { next: { ...state, head: name }, result: { head: name, previousHead } }
  })
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
    throw new BranchConflictError('Cannot rename main branch')
  }
  return mutateDocumentBranches(workspaceId, path, (state) => {
    const current = state.branches.find((b) => b.name === oldName)
    if (!current) {
      throw new BranchNotFoundError(`Branch "${oldName}" not found on ${workspaceId}/${path}`)
    }
    if (oldName === newName) {
      return { next: null, result: current }
    }
    if (state.branches.some((b) => b.name === newName)) {
      throw new BranchConflictError(`Branch "${newName}" already exists on ${workspaceId}/${path}`)
    }
    const renamed: BranchMeta = { ...current, name: newName }
    const nextBranches = state.branches.map((b) => {
      if (b.name === oldName) return renamed
      if (b.baseBranch === oldName) return { ...b, baseBranch: newName }
      return b
    })
    const nextHead = state.head === oldName ? newName : state.head
    return { next: { branches: nextBranches, head: nextHead }, result: renamed }
  })
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
  await mutateDocumentBranches(workspaceId, path, (state) => {
    const idx = state.branches.findIndex((b) => b.name === name)
    if (idx === -1) {
      throw new BranchNotFoundError(`Branch "${name}" not found on ${workspaceId}/${path}`)
    }
    const current = state.branches[idx]!
    if (current.tipFrontiers === tipFrontiers) {
      return { next: null, result: undefined }
    }
    const next: DocumentBranches = {
      ...state,
      branches: [
        ...state.branches.slice(0, idx),
        { ...current, tipFrontiers },
        ...state.branches.slice(idx + 1),
      ],
    }
    return { next, result: undefined }
  })
}
