import { getDataDir } from '../config.js'
import { validateBranchName, validateSlug, validateWorkspaceId } from '../validators.js'
import { getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'
import { getCanvasIdBySlug, upsertCanvasRow } from './db/upsert-workspace.js'

// Canvas-scoped branch state. Backed by:
//   branches table         -> one row per branch keyed on (canvasId, name)
//   canvases.currentBranch -> HEAD pointer per canvas row
//
// All accessors take (workspaceId, slug) so the public API stays stable
// across the slug → canvasId migration. Internally the slug is resolved to
// the stable canvas id before any branches/canvases write.

export interface BranchMeta {
  name: string
  tipFrontiers: string
  baseBranch?: string
  baseVersionId?: string
  color: string
  createdAt: string
}

export interface CanvasBranches {
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

export async function loadCanvasBranches(
  workspaceId: string,
  slug: string,
): Promise<CanvasBranches> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  const db = await dbReady()
  const canvasRow = await db
    .selectFrom('canvases')
    .select(['id', 'currentBranch'])
    .where('workspaceId', '=', workspaceId)
    .where('slug', '=', slug)
    .executeTakeFirst()
  if (!canvasRow) {
    return { branches: [defaultMain()], head: 'main' }
  }
  const branchRows = await db
    .selectFrom('branches')
    .select(['name', 'tipFrontiers', 'sourceBranchName', 'sourceVersionId', 'color', 'createdAt'])
    .where('canvasId', '=', canvasRow.id)
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
  const persistedHead = canvasRow.currentBranch
  const head = branches.some((b) => b.name === persistedHead)
    ? persistedHead
    : branches.some((b) => b.name === 'main')
      ? 'main'
      : branches[0]!.name
  return { branches, head }
}

export async function saveCanvasBranches(
  workspaceId: string,
  slug: string,
  state: CanvasBranches,
): Promise<void> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  for (const branch of state.branches) {
    validateBranchName(branch.name)
  }
  validateBranchName(state.head)
  const db = await dbReady()
  const canvasId = await upsertCanvasRow(db, workspaceId, slug)
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('branches').where('canvasId', '=', canvasId).execute()
    if (state.branches.length > 0) {
      await trx
        .insertInto('branches')
        .values(
          state.branches.map((b) => ({
            canvasId,
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
    await trx
      .updateTable('canvases')
      .set({ currentBranch: state.head, updatedAt: Date.now() })
      .where('id', '=', canvasId)
      .execute()
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
  slug: string,
  opts: {
    name: string
    initialTipFrontiers?: string
    baseBranch?: string
    baseVersionId?: string
    color?: string
  },
): Promise<BranchMeta> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  validateBranchName(opts.name)

  const state = await loadCanvasBranches(workspaceId, slug)
  if (state.branches.some((b) => b.name === opts.name)) {
    throw new BranchConflictError(`Branch "${opts.name}" already exists on ${workspaceId}/${slug}`)
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
  await saveCanvasBranches(workspaceId, slug, next)
  return branch
}

export async function deleteBranch(
  workspaceId: string,
  slug: string,
  name: string,
): Promise<{ ok: true; unmergedCommits: number }> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  validateBranchName(name)
  if (name === 'main') {
    throw new BranchConflictError('Cannot delete main branch')
  }
  const state = await loadCanvasBranches(workspaceId, slug)
  if (!state.branches.some((b) => b.name === name)) {
    throw new BranchNotFoundError(`Branch "${name}" not found on ${workspaceId}/${slug}`)
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
  await saveCanvasBranches(workspaceId, slug, next)
  return { ok: true, unmergedCommits: 0 }
}

export async function setHead(
  workspaceId: string,
  slug: string,
  name: string,
): Promise<{ head: string; previousHead: string }> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  validateBranchName(name)
  const state = await loadCanvasBranches(workspaceId, slug)
  if (!state.branches.some((b) => b.name === name)) {
    throw new BranchNotFoundError(`Branch "${name}" not found on ${workspaceId}/${slug}`)
  }
  const previousHead = state.head
  if (previousHead === name) {
    return { head: name, previousHead }
  }
  await saveCanvasBranches(workspaceId, slug, { ...state, head: name })
  return { head: name, previousHead }
}

export async function renameBranch(
  workspaceId: string,
  slug: string,
  oldName: string,
  newName: string,
): Promise<BranchMeta> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  validateBranchName(oldName)
  validateBranchName(newName)
  if (oldName === 'main') {
    throw new BranchConflictError('Cannot rename main branch')
  }
  const state = await loadCanvasBranches(workspaceId, slug)
  const current = state.branches.find((b) => b.name === oldName)
  if (!current) {
    throw new BranchNotFoundError(`Branch "${oldName}" not found on ${workspaceId}/${slug}`)
  }
  if (oldName === newName) {
    return current
  }
  if (state.branches.some((b) => b.name === newName)) {
    throw new BranchConflictError(`Branch "${newName}" already exists on ${workspaceId}/${slug}`)
  }
  const renamed: BranchMeta = { ...current, name: newName }
  const nextBranches = state.branches.map((b) => {
    if (b.name === oldName) return renamed
    if (b.baseBranch === oldName) return { ...b, baseBranch: newName }
    return b
  })
  const nextHead = state.head === oldName ? newName : state.head
  await saveCanvasBranches(workspaceId, slug, { branches: nextBranches, head: nextHead })
  return renamed
}

export async function getBranchTipBase64(
  workspaceId: string,
  slug: string,
  name: string,
): Promise<string | null> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  validateBranchName(name)
  const state = await loadCanvasBranches(workspaceId, slug)
  const branch = state.branches.find((b) => b.name === name)
  return branch ? branch.tipFrontiers : null
}

export async function updateBranchTip(
  workspaceId: string,
  slug: string,
  name: string,
  tipFrontiers: string,
): Promise<void> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  validateBranchName(name)
  const state = await loadCanvasBranches(workspaceId, slug)
  const idx = state.branches.findIndex((b) => b.name === name)
  if (idx === -1) {
    throw new BranchNotFoundError(`Branch "${name}" not found on ${workspaceId}/${slug}`)
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
  await saveCanvasBranches(workspaceId, slug, next)
}

// ── slug rename ──
// Update only canvases.slug. Branches and versions FK on canvasId so they do
// not need to move; the blob path also uses canvasId so the .loro stays put.
// Returns the canvas id whose slug just changed.
export async function renameCanvasSlug(
  workspaceId: string,
  oldSlug: string,
  newSlug: string,
): Promise<{ canvasId: string }> {
  validateWorkspaceId(workspaceId)
  validateSlug(oldSlug)
  validateSlug(newSlug)
  const db = await dbReady()
  if (oldSlug === newSlug) {
    const id = await getCanvasIdBySlug(db, workspaceId, oldSlug)
    if (!id) {
      throw new Error(`Canvas "${workspaceId}/${oldSlug}" not found`)
    }
    return { canvasId: id }
  }
  const id = await getCanvasIdBySlug(db, workspaceId, oldSlug)
  if (!id) {
    throw new Error(`Canvas "${workspaceId}/${oldSlug}" not found`)
  }
  const taken = await getCanvasIdBySlug(db, workspaceId, newSlug)
  if (taken) {
    throw new Error(`Canvas "${workspaceId}/${newSlug}" already exists`)
  }
  await db
    .updateTable('canvases')
    .set({ slug: newSlug, updatedAt: Date.now() })
    .where('id', '=', id)
    .execute()
  return { canvasId: id }
}
