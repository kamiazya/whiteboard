import { DATA_DIR } from '../config.js'
import { validateSlug, validateWorkspaceId } from '../validators.js'
import { getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'
import { upsertCanvasRow, upsertWorkspaceRow } from './db/upsert-workspace.js'

// Workspace + canvas display names and pin order. Backed by:
//   workspaces.displayName       -> WorkspaceNames.workspace
//   canvases.displayName         -> WorkspaceNames.canvases[slug]
//   canvases.isPinned + pinOrder -> WorkspaceNames.pinned (sorted by pinOrder)
//
// loadWorkspaceNames returns an empty state for workspaces with no rows. The
// previous filesystem implementation also returned an empty state when
// .names.json was missing, so the contract is unchanged for callers.

export interface WorkspaceNames {
  workspace?: string
  canvases: Record<string, string>
  pinned: string[]
}

async function dbReady() {
  await prepareDataDir(DATA_DIR)
  return getDb(DATA_DIR)
}

export async function loadWorkspaceNames(workspaceId: string): Promise<WorkspaceNames> {
  validateWorkspaceId(workspaceId)
  const db = await dbReady()
  const wsRow = await db
    .selectFrom('workspaces')
    .select(['displayName'])
    .where('id', '=', workspaceId)
    .executeTakeFirst()
  const canvasRows = await db
    .selectFrom('canvases')
    .select(['slug', 'displayName', 'isPinned', 'pinOrder'])
    .where('workspaceId', '=', workspaceId)
    .execute()
  const canvases: Record<string, string> = {}
  const pinned: Array<{ slug: string; order: number }> = []
  for (const row of canvasRows) {
    if (row.displayName !== null) {
      canvases[row.slug] = row.displayName
    }
    if (row.isPinned === 1) {
      pinned.push({ slug: row.slug, order: row.pinOrder ?? Number.MAX_SAFE_INTEGER })
    }
  }
  pinned.sort((a, b) => a.order - b.order)
  const out: WorkspaceNames = {
    canvases,
    pinned: pinned.map((p) => p.slug),
  }
  if (wsRow?.displayName) {
    out.workspace = wsRow.displayName
  }
  return out
}

export async function setWorkspaceName(workspaceId: string, name: string): Promise<WorkspaceNames> {
  validateWorkspaceId(workspaceId)
  const trimmed = name.trim()
  const db = await dbReady()
  await upsertWorkspaceRow(db, workspaceId)
  const now = Date.now()
  await db
    .updateTable('workspaces')
    .set({
      displayName: trimmed.length > 0 ? trimmed : null,
      updatedAt: now,
    })
    .where('id', '=', workspaceId)
    .execute()
  return loadWorkspaceNames(workspaceId)
}

export async function setCanvasName(
  workspaceId: string,
  slug: string,
  name: string,
): Promise<WorkspaceNames> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  const trimmed = name.trim()
  const db = await dbReady()
  await upsertCanvasRow(db, workspaceId, slug)
  const now = Date.now()
  await db
    .updateTable('canvases')
    .set({
      displayName: trimmed.length > 0 ? trimmed : null,
      updatedAt: now,
    })
    .where('workspaceId', '=', workspaceId)
    .where('slug', '=', slug)
    .execute()
  return loadWorkspaceNames(workspaceId)
}

// Pin / unpin a canvas. Idempotent:
//   - pinned=true on a not-yet-pinned canvas: append at the end (max pinOrder+1)
//   - pinned=true on an already-pinned canvas: no-op, order preserved
//   - pinned=false: clear isPinned + pinOrder
export async function setCanvasPinned(
  workspaceId: string,
  slug: string,
  pinned: boolean,
): Promise<WorkspaceNames> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  const db = await dbReady()
  await upsertCanvasRow(db, workspaceId, slug)
  await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('canvases')
      .select(['isPinned', 'pinOrder'])
      .where('workspaceId', '=', workspaceId)
      .where('slug', '=', slug)
      .executeTakeFirst()
    if (!row) return
    const isPinnedNow = row.isPinned === 1
    if (pinned && !isPinnedNow) {
      const max = await trx
        .selectFrom('canvases')
        .select((eb) => eb.fn.max('pinOrder').as('maxOrder'))
        .where('workspaceId', '=', workspaceId)
        .where('isPinned', '=', 1)
        .executeTakeFirst()
      const nextOrder = (max?.maxOrder ?? -1) + 1
      await trx
        .updateTable('canvases')
        .set({ isPinned: 1, pinOrder: nextOrder, updatedAt: Date.now() })
        .where('workspaceId', '=', workspaceId)
        .where('slug', '=', slug)
        .execute()
    } else if (!pinned && isPinnedNow) {
      await trx
        .updateTable('canvases')
        .set({ isPinned: 0, pinOrder: null, updatedAt: Date.now() })
        .where('workspaceId', '=', workspaceId)
        .where('slug', '=', slug)
        .execute()
    }
  })
  return loadWorkspaceNames(workspaceId)
}
