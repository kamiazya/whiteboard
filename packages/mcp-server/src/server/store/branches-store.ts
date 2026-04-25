import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DATA_DIR } from '../config.js'
import {
  validateBranchName,
  validateSessionId,
  validateSlug,
} from '../validators.js'
import { CorruptStoredDataError, isMissingFileError } from './corrupt-stored-data.js'

// Canvas-scoped branch state store. For each canvas it keeps:
// - which branches exist (tipFrontiers / color / origin)
// - which branch is currently HEAD
// See docs/version-branching-spec.md §3.1.
//
// Persistence: {DATA_DIR}/{sessionId}/branches/{slug}.json
// - hierarchical slugs (for example "621/header") expand into subdirectories
// - when the file is missing, loadCanvasBranches lazily returns a default main branch without writing
//
// Keep this separate from names-store (session-scoped workspace / pin) so branch data
// does not create migration conflicts or schema bloat.

export interface BranchMeta {
  // Unique within the canvas. Follows the same rules as slug.
  name: string
  // LoroDoc.frontiers() -> encodeFrontiers -> base64. Empty string means uninitialized.
  tipFrontiers: string
  // Source branch at creation time. Informational after that. main itself stays undefined.
  baseBranch?: string
  // Source version id, used by UI labels such as "branched from main @ v-abc".
  baseVersionId?: string
  // #RRGGBB used by the UI chip and mini-graph lane.
  color: string
  // ISO timestamp.
  createdAt: string
}

export interface CanvasBranches {
  branches: BranchMeta[]
  head: string
}

// Default color for the main branch. Matches the UI blue.
export const DEFAULT_MAIN_COLOR = '#1971c2'

function branchesPath(sessionId: string, slug: string): string {
  return join(DATA_DIR, sessionId, 'branches', `${slug}.json`)
}

function defaultMain(): BranchMeta {
  return {
    name: 'main',
    tipFrontiers: '',
    color: DEFAULT_MAIN_COLOR,
    createdAt: new Date().toISOString(),
  }
}

function isValidBranchMeta(value: unknown): value is BranchMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Partial<BranchMeta>
  if (typeof v.name !== 'string' || v.name.length === 0) return false
  try {
    validateBranchName(v.name)
  } catch {
    return false
  }
  if (typeof v.tipFrontiers !== 'string') return false
  if (typeof v.color !== 'string') return false
  if (typeof v.createdAt !== 'string') return false
  if (v.baseBranch !== undefined) {
    if (typeof v.baseBranch !== 'string') return false
    try {
      validateBranchName(v.baseBranch)
    } catch {
      return false
    }
  }
  if (v.baseVersionId !== undefined && typeof v.baseVersionId !== 'string') return false
  return true
}

// ── load (returns a default main branch when the file is missing; does not persist it) ──
// If the file exists but JSON parsing or schema validation fails, throw CorruptStoredDataError.
// Keep "missing" (ENOENT) distinct from "corrupt".
export async function loadCanvasBranches(
  sessionId: string,
  slug: string,
): Promise<CanvasBranches> {
  validateSessionId(sessionId)
  validateSlug(slug)
  const path = branchesPath(sessionId, slug)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if (isMissingFileError(err)) {
      return { branches: [defaultMain()], head: 'main' }
    }
    throw err
  }
  let parsed: Partial<CanvasBranches>
  try {
    parsed = JSON.parse(raw) as Partial<CanvasBranches>
  } catch (err) {
    throw new CorruptStoredDataError(
      `Stored data at "${path}" is corrupt: invalid JSON (${(err as Error).message})`,
    )
  }
  if (!Array.isArray(parsed.branches) || !parsed.branches.every(isValidBranchMeta)) {
    throw new CorruptStoredDataError(
      `Stored data at "${path}" is corrupt: invalid branches[] schema`,
    )
  }
  const branches = parsed.branches as BranchMeta[]
  if (branches.length === 0) {
    throw new CorruptStoredDataError(
      `Stored data at "${path}" is corrupt: branches[] must contain at least one branch`,
    )
  }
  if (typeof parsed.head !== 'string' || !branches.some((b) => b.name === parsed.head)) {
    throw new CorruptStoredDataError(
      `Stored data at "${path}" is corrupt: head "${String(parsed.head)}" is not present in branches[]`,
    )
  }
  return { branches, head: parsed.head }
}

// ── save (auto-creates parent directories) ──
export async function saveCanvasBranches(
  sessionId: string,
  slug: string,
  state: CanvasBranches,
): Promise<void> {
  validateSessionId(sessionId)
  validateSlug(slug)
  const path = branchesPath(sessionId, slug)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(state, null, 2))
}

// Give these errors stable names so callers can distinguish conflict vs not found.
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

// Default color palette used when color is omitted.
const BRANCH_COLOR_PALETTE = [
  '#9333ea', // purple (experimental)
  '#2f9e44', // green  (hotfix)
  '#e03131', // red
  '#f08c00', // amber
  '#0c8599', // teal
  '#e64980', // pink
]

function nextColor(existing: BranchMeta[]): string {
  const used = new Set(existing.map((b) => b.color.toLowerCase()))
  for (const c of BRANCH_COLOR_PALETTE) {
    if (!used.has(c.toLowerCase())) return c
  }
  return BRANCH_COLOR_PALETTE[existing.length % BRANCH_COLOR_PALETTE.length]!
}

// ── createBranch ──
// initialTipFrontiers is resolved by the caller, typically with help from version-store.
// Omit it to start with an empty string for uninitialized branches.
export async function createBranch(
  sessionId: string,
  slug: string,
  opts: {
    name: string
    initialTipFrontiers?: string
    baseBranch?: string
    baseVersionId?: string
    color?: string
  },
): Promise<BranchMeta> {
  validateSessionId(sessionId)
  validateSlug(slug)
  validateBranchName(opts.name)

  const state = await loadCanvasBranches(sessionId, slug)
  if (state.branches.some((b) => b.name === opts.name)) {
    throw new BranchConflictError(`Branch "${opts.name}" already exists on ${sessionId}/${slug}`)
  }
  const branch: BranchMeta = {
    name: opts.name,
    tipFrontiers: opts.initialTipFrontiers ?? '',
    color: opts.color ?? nextColor(state.branches),
    createdAt: new Date().toISOString(),
    ...(opts.baseBranch !== undefined ? { baseBranch: opts.baseBranch } : {}),
    ...(opts.baseVersionId !== undefined ? { baseVersionId: opts.baseVersionId } : {}),
  }
  const next: CanvasBranches = { ...state, branches: [...state.branches, branch] }
  await saveCanvasBranches(sessionId, slug, next)
  return branch
}

// ── deleteBranch ──
// main and the current HEAD cannot be deleted. This store returns 0 as the placeholder
// unmergedCommits value; routes that need the real count must consult version-store.
export async function deleteBranch(
  sessionId: string,
  slug: string,
  name: string,
): Promise<{ ok: true; unmergedCommits: number }> {
  validateSessionId(sessionId)
  validateSlug(slug)
  validateBranchName(name)
  if (name === 'main') {
    throw new BranchConflictError('Cannot delete main branch')
  }
  const state = await loadCanvasBranches(sessionId, slug)
  if (!state.branches.some((b) => b.name === name)) {
    throw new BranchNotFoundError(`Branch "${name}" not found on ${sessionId}/${slug}`)
  }
  if (state.head === name) {
    throw new BranchConflictError(
      `Cannot delete branch "${name}" while it is HEAD. setHead to another branch first.`,
    )
  }
  const next: CanvasBranches = {
    ...state,
    branches: state.branches.filter((b) => b.name !== name),
  }
  await saveCanvasBranches(sessionId, slug, next)
  return { ok: true, unmergedCommits: 0 }
}

// ── setHead ──
// Return NotFound for unknown branches. Idempotent: previousHead is the old head, head is the new head.
// This store only persists metadata; route-level code performs any live LoroDoc checkout.
export async function setHead(
  sessionId: string,
  slug: string,
  name: string,
): Promise<{ head: string; previousHead: string }> {
  validateSessionId(sessionId)
  validateSlug(slug)
  validateBranchName(name)
  const state = await loadCanvasBranches(sessionId, slug)
  if (!state.branches.some((b) => b.name === name)) {
    throw new BranchNotFoundError(`Branch "${name}" not found on ${sessionId}/${slug}`)
  }
  const previousHead = state.head
  if (previousHead === name) {
    return { head: name, previousHead }
  }
  await saveCanvasBranches(sessionId, slug, { ...state, head: name })
  return { head: name, previousHead }
}

// ── renameBranch ──
// main cannot be renamed. Conflicts return Conflict, missing branches return NotFound.
// If HEAD is renamed, update head too. Also rewrite baseBranch references that still point at the old name.
// version-store branchName updates are handled separately in the route layer.
export async function renameBranch(
  sessionId: string,
  slug: string,
  oldName: string,
  newName: string,
): Promise<BranchMeta> {
  validateSessionId(sessionId)
  validateSlug(slug)
  validateBranchName(oldName)
  validateBranchName(newName)
  if (oldName === 'main') {
    throw new BranchConflictError('Cannot rename main branch')
  }
  const state = await loadCanvasBranches(sessionId, slug)
  const current = state.branches.find((b) => b.name === oldName)
  if (!current) {
    throw new BranchNotFoundError(`Branch "${oldName}" not found on ${sessionId}/${slug}`)
  }
  if (oldName === newName) {
    // no-op
    return current
  }
  if (state.branches.some((b) => b.name === newName)) {
    throw new BranchConflictError(
      `Branch "${newName}" already exists on ${sessionId}/${slug}`,
    )
  }
  const renamed: BranchMeta = { ...current, name: newName }
  const nextBranches = state.branches.map((b) => {
    if (b.name === oldName) return renamed
    if (b.baseBranch === oldName) return { ...b, baseBranch: newName }
    return b
  })
  const nextHead = state.head === oldName ? newName : state.head
  await saveCanvasBranches(sessionId, slug, { branches: nextBranches, head: nextHead })
  return renamed
}

// ── getBranchTipBase64 ──
// Getter used by route-layer merge flows to read target / source tipFrontiers.
// Returns null for missing branches and preserves the empty string for uninitialized branches.
export async function getBranchTipBase64(
  sessionId: string,
  slug: string,
  name: string,
): Promise<string | null> {
  validateSessionId(sessionId)
  validateSlug(slug)
  validateBranchName(name)
  const state = await loadCanvasBranches(sessionId, slug)
  const branch = state.branches.find((b) => b.name === name)
  return branch ? branch.tipFrontiers : null
}

// ── updateBranchTip ──
// Overwrite a branch tipFrontiers value. Used to save the previous HEAD's current frontiers
// during branch switches and to refresh the new HEAD tip after checkout.
// Throws NotFound for missing branches.
export async function updateBranchTip(
  sessionId: string,
  slug: string,
  name: string,
  tipFrontiers: string,
): Promise<void> {
  validateSessionId(sessionId)
  validateSlug(slug)
  validateBranchName(name)
  const state = await loadCanvasBranches(sessionId, slug)
  const idx = state.branches.findIndex((b) => b.name === name)
  if (idx === -1) {
    throw new BranchNotFoundError(`Branch "${name}" not found on ${sessionId}/${slug}`)
  }
  const current = state.branches[idx]!
  if (current.tipFrontiers === tipFrontiers) return
  const next: CanvasBranches = {
    ...state,
    branches: [
      ...state.branches.slice(0, idx),
      { ...current, tipFrontiers },
      ...state.branches.slice(idx + 1),
    ],
  }
  await saveCanvasBranches(sessionId, slug, next)
}
