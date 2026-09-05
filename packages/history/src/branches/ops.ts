/**
 * Branch operations as pure functions over `DocumentBranchesState`.
 *
 * Each answers the next state (or `null` when nothing needs writing) and a
 * result, and throws one of the two typed errors below. A keeper wraps one
 * in whatever read-modify-write it has — the daemon's per-workspace write
 * lock over a row read, the browser's write queue over the record — so the
 * rules (no duplicate names, `main` is neither deleted nor renamed, HEAD is
 * never deleted, a rename follows HEAD and every `baseBranch` that named it)
 * live in one place and cannot differ by keeper.
 */
import { type BranchMeta, type DocumentBranchesState, MAIN_BRANCH } from './schema.js'

/** Stable error names so a caller can tell a conflict from a miss without a message parse. */
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

export interface BranchOpResult<T> {
  /** The state to persist, or null when the operation changed nothing. */
  readonly next: DocumentBranchesState | null
  readonly result: T
}

const BRANCH_COLOR_PALETTE = ['#9333ea', '#2f9e44', '#e03131', '#f08c00', '#0c8599', '#e64980']

/** The first palette colour no existing branch wears; cycles once the palette is spent. */
export function nextBranchColor(existing: readonly BranchMeta[]): string {
  const used = new Set(existing.map((b) => b.color.toLowerCase()))
  for (const c of BRANCH_COLOR_PALETTE) {
    if (!used.has(c.toLowerCase())) return c
  }
  return BRANCH_COLOR_PALETTE[existing.length % BRANCH_COLOR_PALETTE.length] as string
}

export interface CreateBranchOptions {
  readonly name: string
  readonly initialTipFrontiers?: string
  readonly baseBranch?: string
  readonly baseVersionId?: string
  readonly color?: string
  readonly now?: Date
}

/** Where the document is, for the error messages a keeper hands its caller. */
export interface BranchScope {
  readonly workspaceId: string
  readonly path: string
}

export function createBranch(
  state: DocumentBranchesState,
  scope: BranchScope,
  opts: CreateBranchOptions,
): BranchOpResult<BranchMeta> {
  if (state.branches.some((b) => b.name === opts.name)) {
    throw new BranchConflictError(
      `Branch "${opts.name}" already exists on ${scope.workspaceId}/${scope.path}`,
    )
  }
  const branch: BranchMeta = {
    name: opts.name,
    tipFrontiers: opts.initialTipFrontiers ?? '',
    color: opts.color ?? nextBranchColor(state.branches),
    createdAt: (opts.now ?? new Date()).toISOString(),
    ...(opts.baseBranch !== undefined ? { baseBranch: opts.baseBranch } : {}),
    ...(opts.baseVersionId !== undefined ? { baseVersionId: opts.baseVersionId } : {}),
  }
  return { next: { ...state, branches: [...state.branches, branch] }, result: branch }
}

export function deleteBranch(
  state: DocumentBranchesState,
  scope: BranchScope,
  name: string,
): BranchOpResult<{ ok: true; unmergedCommits: number }> {
  if (name === MAIN_BRANCH) {
    throw new BranchConflictError('Cannot delete main branch')
  }
  if (!state.branches.some((b) => b.name === name)) {
    throw new BranchNotFoundError(
      `Branch "${name}" not found on ${scope.workspaceId}/${scope.path}`,
    )
  }
  if (state.head === name) {
    throw new BranchConflictError(
      `Cannot delete branch "${name}" while it is HEAD. setHead to another branch first.`,
    )
  }
  return {
    next: { ...state, branches: state.branches.filter((b) => b.name !== name) },
    result: { ok: true, unmergedCommits: 0 },
  }
}

export function setHead(
  state: DocumentBranchesState,
  scope: BranchScope,
  name: string,
): BranchOpResult<{ head: string; previousHead: string }> {
  if (!state.branches.some((b) => b.name === name)) {
    throw new BranchNotFoundError(
      `Branch "${name}" not found on ${scope.workspaceId}/${scope.path}`,
    )
  }
  const previousHead = state.head
  if (previousHead === name) return { next: null, result: { head: name, previousHead } }
  return { next: { ...state, head: name }, result: { head: name, previousHead } }
}

export function renameBranch(
  state: DocumentBranchesState,
  scope: BranchScope,
  oldName: string,
  newName: string,
): BranchOpResult<BranchMeta> {
  if (oldName === MAIN_BRANCH) {
    throw new BranchConflictError('Cannot rename main branch')
  }
  const current = state.branches.find((b) => b.name === oldName)
  if (current === undefined) {
    throw new BranchNotFoundError(
      `Branch "${oldName}" not found on ${scope.workspaceId}/${scope.path}`,
    )
  }
  if (oldName === newName) return { next: null, result: current }
  if (state.branches.some((b) => b.name === newName)) {
    throw new BranchConflictError(
      `Branch "${newName}" already exists on ${scope.workspaceId}/${scope.path}`,
    )
  }
  const renamed: BranchMeta = { ...current, name: newName }
  const branches = state.branches.map((b) => {
    if (b.name === oldName) return renamed
    if (b.baseBranch === oldName) return { ...b, baseBranch: newName }
    return b
  })
  const head = state.head === oldName ? newName : state.head
  return { next: { branches, head }, result: renamed }
}

export function updateBranchTip(
  state: DocumentBranchesState,
  scope: BranchScope,
  name: string,
  tipFrontiers: string,
): BranchOpResult<undefined> {
  const idx = state.branches.findIndex((b) => b.name === name)
  if (idx === -1) {
    throw new BranchNotFoundError(
      `Branch "${name}" not found on ${scope.workspaceId}/${scope.path}`,
    )
  }
  const current = state.branches[idx] as BranchMeta
  if (current.tipFrontiers === tipFrontiers) return { next: null, result: undefined }
  return {
    next: {
      ...state,
      branches: [
        ...state.branches.slice(0, idx),
        { ...current, tipFrontiers },
        ...state.branches.slice(idx + 1),
      ],
    },
    result: undefined,
  }
}
