import { access, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CanvasKind } from '@kamiazya/whiteboard-canvas-model'
import type { Value } from 'loro-crdt'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { nanoid } from 'nanoid'
import type { CanvasSummary } from '../../shared/api-contracts/canvas.js'
import { getDataDir } from '../config.js'
import { getLogger } from '../log.js'
import { validateCanvasId, validateSlug, validateWorkspaceId } from '../validators.js'
import {
  corruptStoredData,
  isCorruptStoredDataError,
  isMissingFileError,
} from './corrupt-stored-data.js'
import { getDb, registerDbDisposeHook } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'
import { getCanvasIdBySlug, upsertWorkspaceRow } from './db/upsert-workspace.js'
import type { VersionStore } from './version-store.js'
import { thumbnailPath } from './version-store.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

// Give the error a stable name so callers, including MCP tools, can detect overwrite conflicts.
export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

// ── canvas blob path helpers ──
// Snapshots live under {dataDir}/blobs/{workspaceId}/canvas/{canvasId}.loro.
// The canvasId is the stable nanoid PK from the canvases table, so renaming a
// canvas slug does not move blobs around.
function blobsRoot(): string {
  return join(getDataDir(), 'blobs')
}

function canvasBlobPath(workspaceId: string, canvasId: string): string {
  validateWorkspaceId(workspaceId)
  validateCanvasId(canvasId)
  return join(blobsRoot(), workspaceId, 'canvas', `${canvasId}.loro`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'unknown error'
}

// Soft cap for snapshot size. Do not block saves when exceeded because preserving user
// data is more important; emit one warning per threshold breach and suggest compactCanvas().
const SNAPSHOT_WARN_BYTES = 32 * 1024 * 1024 // 32 MiB
const warnedSnapshots = new Set<string>()

async function dbReady() {
  await prepareDataDir(getDataDir())
  return getDb(getDataDir())
}

// ── save LoroDoc by writing the snapshot binary to the blobs/ tree and
//    upserting the matching DB rows. ──
// overwrite defaults to false so canvas_create does not destroy existing
// data by mistake. Normal incremental saves (WS updates, applyAndPersist,
// compactCanvas) must pass overwrite: true.
export async function saveCanvas(
  workspaceId: string,
  slug: string,
  doc: LoroDoc,
  options: { overwrite?: boolean; kind?: CanvasKind } = {},
): Promise<void> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  // Hold the workspace write barrier across the snapshot write + DB
  // upsert so a concurrent purgeDanglingFiles cannot observe a referenced
  // file as dangling: GC's collectReferencedFileIds() runs over the same
  // workspace blobs we are about to mutate, and chaining both behind the
  // workspace lock ensures it sees this save as either fully applied or
  // not yet started.
  return withWorkspaceWriteLock(workspaceId, async () => {
    const overwrite = options.overwrite ?? false
    const db = await dbReady()
    const existingCanvasId = await getCanvasIdBySlug(db, workspaceId, slug)
    if (existingCanvasId && !overwrite) {
      throw new ConflictError(
        `Canvas "${workspaceId}/${slug}" already exists. Pass { overwrite: true } to replace it.`,
      )
    }
    // Pre-allocate the canvasId for new canvases so the blob can be written
    // before any metadata row commits. If the FS write fails (ENOSPC, EACCES,
    // transient corruption) we leave no DB row behind, so a retry can succeed
    // instead of hitting a phantom ConflictError on the orphan.
    const canvasId = existingCanvasId ?? nanoid(12)
    const path = canvasBlobPath(workspaceId, canvasId)
    await mkdir(dirname(path), { recursive: true })
    const snapshot = doc.export({ mode: 'snapshot' })
    await writeFile(path, snapshot)
    await upsertWorkspaceRow(db, workspaceId)
    if (existingCanvasId) {
      // A plain re-save (WS updates, applyAndPersist, compactCanvas) omits
      // `kind` and must never touch the stored value. An explicit `kind` is
      // an intentional sync request (e.g. restore reconciling a different-
      // kind source's content onto an existing target) and is honored.
      await db
        .updateTable('canvases')
        .set({
          updatedAt: Date.now(),
          ...(options.kind !== undefined ? { kind: options.kind } : {}),
        })
        .where('id', '=', canvasId)
        .execute()
    } else {
      const now = Date.now()
      await db
        .insertInto('canvases')
        .values({
          id: canvasId,
          workspaceId,
          slug,
          displayName: null,
          isPinned: 0,
          pinOrder: null,
          currentBranch: 'main',
          createdAt: now,
          updatedAt: now,
          // Written on insert. The update branch above honors an explicit
          // `kind` too (a plain re-save omits it and leaves the stored value
          // untouched); the onConflict branch below is the rare
          // insert-raced-with-a-concurrent-insert fallback and, like a plain
          // re-save, does not touch `kind`.
          kind: options.kind ?? null,
        })
        .onConflict((oc) => oc.columns(['workspaceId', 'slug']).doUpdateSet({ updatedAt: now }))
        .execute()
    }
    if (snapshot.byteLength > SNAPSHOT_WARN_BYTES) {
      const key = `${workspaceId}/${slug}`
      if (!warnedSnapshots.has(key)) {
        warnedSnapshots.add(key)
        getLogger('canvas-store').warning(
          {
            workspaceId,
            slug,
            bytes: snapshot.byteLength,
            thresholdBytes: SNAPSHOT_WARN_BYTES,
          },
          'snapshot exceeds soft cap; consider compactCanvas() to GC op-log',
        )
      }
    }
    // Hand off to the auto-compact debouncer when one is registered. Wired
    // by the route layer (where versionStore is in scope) so this module
    // does not depend on the version-store concrete type.
    if (autoCompactTrigger) {
      try {
        autoCompactTrigger(workspaceId, slug)
      } catch (err) {
        getLogger('canvas-store').warning({ workspaceId, slug, err }, 'autoCompactTrigger threw')
      }
    }
  })
}

// ── load LoroDoc, returning an empty document when the blob is missing ──
export async function loadCanvas(workspaceId: string, slug: string): Promise<LoroDoc> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  const db = await dbReady()
  const canvasId = await getCanvasIdBySlug(db, workspaceId, slug)
  if (!canvasId) return new LoroDoc()
  const path = canvasBlobPath(workspaceId, canvasId)
  let doc: LoroDoc
  try {
    const bytes = await readFile(path)
    try {
      doc = LoroDoc.fromSnapshot(new Uint8Array(bytes))
    } catch (error) {
      throw corruptStoredData(path, `invalid canvas snapshot (${errorMessage(error)})`)
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return new LoroDoc()
    }
    if (isCorruptStoredDataError(error)) {
      throw error
    }
    throw corruptStoredData(path, `failed to read canvas snapshot (${errorMessage(error)})`)
  }
  // One-shot legacy container migration. Older data stored "elements" in
  // LoroList; current code uses LoroMovableList. Repair on load and rewrite.
  const migrated = migrateLegacyListToMovable(doc)
  if (migrated) {
    try {
      const bakPath = `${path}.pre-migrate-bak`
      const bakExists = await access(bakPath)
        .then(() => true)
        .catch(() => false)
      if (!bakExists) {
        const origBytes = await readFile(path).catch(() => null)
        if (origBytes) await writeFile(bakPath, origBytes)
      }
      await saveCanvas(workspaceId, slug, doc, { overwrite: true })
    } catch (err) {
      getLogger('canvas-store').warning(
        { workspaceId, slug, err: err as Error },
        'legacy list→movable migration persist failed',
      )
    }
  }
  return doc
}

function migrateLegacyListToMovable(doc: LoroDoc): boolean {
  const list = doc.getList('elements')
  const movable = doc.getMovableList('elements')
  if (list.length === 0) return false
  if (movable.length > 0) return false
  for (let i = 0; i < list.length; i++) {
    const item = list.get(i)
    if (!(item instanceof LoroMap)) continue
    const json = item.toJSON() as Record<string, unknown>
    const dst = movable.insertContainer(movable.length, new LoroMap())
    for (const [k, v] of Object.entries(json)) {
      if (v !== undefined) dst.set(k, v as Value)
    }
  }
  list.delete(0, list.length)
  doc.commit()
  return true
}

/**
 * Whether this daemon has ever registered the workspace.
 *
 * Exists so read surfaces can tell "empty" from "never heard of it". Nothing
 * mints workspace ids ahead of use any more, but ids OUTLIVE the daemon that
 * minted them — a browser keeps its paired workspace id in localStorage, and
 * a rebuilt data dir does not know it. Answering such an id with empty lists
 * and lazily-created empty docs reads exactly like the user's data being
 * gone, when the truth is "not here".
 */
export async function workspaceExists(workspaceId: string): Promise<boolean> {
  validateWorkspaceId(workspaceId)
  const db = await dbReady()
  const row = await db
    .selectFrom('workspaces')
    .select(['id'])
    .where('id', '=', workspaceId)
    .executeTakeFirst()
  return row !== undefined
}

export async function canvasExists(workspaceId: string, slug: string): Promise<boolean> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  const db = await dbReady()
  const canvasId = await getCanvasIdBySlug(db, workspaceId, slug)
  return canvasId !== null
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isMissingFileError(error)) throw error
  }
}

// ── delete a canvas and every file it owns ──
// Returns false (never throws) for a missing canvas so callers can treat
// "already gone" and "just deleted" the same way an idempotent DELETE
// should.
//
// Order matters for the crash-safety story: the DB row goes first, so a
// crash between the row delete and the file unlinks below leaves orphan
// blob/thumbnail files (invisible — nothing lists the deleted canvasId
// anymore) rather than the reverse — a listed canvas whose content is
// already gone.
// ponytail: orphaned files from that crash window are not swept by
// file-gc (its collectReferencedFileIds targets uploaded images, not these
// canvas/version blobs); revisit if orphan blobs start showing up in the
// storage report.
export async function deleteCanvas(workspaceId: string, slug: string): Promise<boolean> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  return withWorkspaceWriteLock(workspaceId, async () => {
    const db = await dbReady()
    const canvasId = await getCanvasIdBySlug(db, workspaceId, slug)
    if (!canvasId) return false

    // Collect version ids before the row delete — the versions rows are
    // gone the instant the cascade fires, so their ids must be captured
    // first to know which thumbnail files to unlink.
    const versionRows = await db
      .selectFrom('versions')
      .select(['id'])
      .where('canvasId', '=', canvasId)
      .execute()

    // branches/versions rows cascade via the ON DELETE CASCADE FKs
    // declared in migration 0001 (PRAGMA foreign_keys=ON is set per
    // connection in db/index.ts).
    await db.deleteFrom('canvases').where('id', '=', canvasId).execute()

    const path = canvasBlobPath(workspaceId, canvasId)
    await unlinkIfExists(path)
    await unlinkIfExists(`${path}.pre-migrate-bak`)
    for (const { id: versionId } of versionRows) {
      await unlinkIfExists(thumbnailPath(workspaceId, versionId))
    }

    // Force the next getDoc() to reload from disk (there is nothing left to
    // reload from — a fresh create should not inherit a doc instance that
    // still holds the deleted canvas's history).
    const { evictDoc } = await import('./doc-cache.js')
    evictDoc(workspaceId, slug)

    return true
  })
}

// Null for both "no such canvas" and "the canvas records no kind" — its
// callers want the same thing from either, which is to stamp nothing.
//
// This deliberately does NOT resolve an unset kind to 'spatial' the way
// listCanvases does. The difference is what the answer is used for: a list
// renders a badge, while this feeds a WRITE onto a restored canvas's row.
// A guess that gets stored outlives the guess — a markdown document that
// predates kinds would become permanently spatial and open in the wrong
// editor, which is the exact failure the callers' comments say they are
// copying the source's kind to avoid.
export async function getCanvasKind(workspaceId: string, slug: string): Promise<CanvasKind | null> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  const db = await dbReady()
  const row = await db
    .selectFrom('canvases')
    .select(['kind'])
    .where('workspaceId', '=', workspaceId)
    .where('slug', '=', slug)
    .executeTakeFirst()
  return row?.kind ?? null
}

export interface CompactResult {
  compacted: boolean
  beforeBytes: number
  afterBytes: number
  reason?: 'no-versions' | 'no-file' | 'no-gain' | 'ok'
}

export async function compactCanvas(
  workspaceId: string,
  slug: string,
  versionStore: VersionStore,
): Promise<CompactResult> {
  validateWorkspaceId(workspaceId)
  validateSlug(slug)
  const db = await dbReady()
  const canvasId = await getCanvasIdBySlug(db, workspaceId, slug)
  if (!canvasId) {
    return { compacted: false, beforeBytes: 0, afterBytes: 0, reason: 'no-file' }
  }
  const path = canvasBlobPath(workspaceId, canvasId)
  let beforeBytes: number
  try {
    beforeBytes = (await stat(path)).size
  } catch (error) {
    if (isMissingFileError(error)) {
      return { compacted: false, beforeBytes: 0, afterBytes: 0, reason: 'no-file' }
    }
    throw corruptStoredData(path, `failed to stat canvas file (${errorMessage(error)})`)
  }

  const cut = await versionStore.earliestFrontiers(workspaceId, slug)
  if (!cut) {
    return { compacted: false, beforeBytes, afterBytes: beforeBytes, reason: 'no-versions' }
  }

  const doc = await loadCanvas(workspaceId, slug)
  const shallow = doc.export({ mode: 'shallow-snapshot', frontiers: cut })
  if (shallow.byteLength >= beforeBytes) {
    return { compacted: false, beforeBytes, afterBytes: beforeBytes, reason: 'no-gain' }
  }
  await writeFile(path, shallow)
  // Stamp the canvas row so the auto-Optimize loop can skip canvases that
  // have not changed since the last successful compaction, and so the UI
  // can surface "Auto-optimised Ns ago" without reading file mtimes.
  await db
    .updateTable('canvases')
    .set({ lastCompactedAt: Date.now() })
    .where('id', '=', canvasId)
    .execute()
  // Drop the cached LoroDoc for this canvas. Without this, a still-resident
  // full doc (held open by an active WS connection or a previous getDoc)
  // would be re-exported on the next save and clobber the shallow snapshot
  // we just wrote. Done inside compactCanvas so every caller — manual
  // optimize_canvases route and the debounced auto-compact alike — gets
  // the same invariant for free.
  const { evictDoc } = await import('./doc-cache.js')
  evictDoc(workspaceId, slug)
  return { compacted: true, beforeBytes, afterBytes: shallow.byteLength, reason: 'ok' }
}

// ── most-recent auto-compact timestamp across all canvases ───────────
// Used by the storage report to show "Auto-optimised Ns ago" without
// client-side aggregation. Returns null when no canvas has been compacted yet.
export async function readLatestCompactedAt(): Promise<number | null> {
  const db = await dbReady()
  const row = await db
    .selectFrom('canvases')
    .select((eb) => eb.fn.max('lastCompactedAt').as('maxAt'))
    .executeTakeFirst()
  const value = row?.maxAt ?? null
  return value === null || typeof value !== 'number' ? null : value
}

// ── auto-compact debouncer ────────────────────────────────────────────
// saveCanvas calls a registered trigger after every write. The route layer
// wires that trigger to scheduleAutoCompact below; tests can register a spy
// instead to verify call ordering. Per-canvas timers coalesce a burst of
// edits into a single compaction once the editing pause exceeds debounceMs.
type AutoCompactTrigger = (workspaceId: string, slug: string) => void
let autoCompactTrigger: AutoCompactTrigger | null = null

// Shared by setAutoCompactTrigger(null) and disposeAutoCompact() so the two
// cancellation paths can never drift out of sync with each other.
function clearAllAutoCompactTimers(): void {
  for (const t of autoCompactTimers.values()) clearTimeout(t)
  autoCompactTimers.clear()
}

// Resetting the trigger to null also drains any pending debounced timers so
// a subsequent test's tempDir is not surprised by a stray compactCanvas
// firing on a removed directory. This stays synchronous by contract — it
// cancels only timers that have not fired yet, and deliberately does not
// await in-flight compactions (see disposeAutoCompact for that superset).
export function setAutoCompactTrigger(fn: AutoCompactTrigger | null): void {
  if (fn === null) {
    clearAllAutoCompactTimers()
  }
  autoCompactTrigger = fn
}

const AUTO_COMPACT_DEBOUNCE_MS = 30_000
const autoCompactTimers = new Map<string, ReturnType<typeof setTimeout>>()

// Tracks compactCanvas() calls that have already fired but not yet settled.
// A Set of the promises themselves (not a Map keyed by workspaceId/slug) is
// required: two overlapping compactions for the same key must both stay
// tracked until they individually settle, since a keyed map with an
// unconditional delete-on-settle would let a still-in-flight entry get
// dropped by an unrelated compaction for the same key finishing first.
const inFlightAutoCompacts = new Set<Promise<unknown>>()

// True only for the duration of a disposeAutoCompact() call. An in-flight
// compaction's loadCanvas() can run legacy migration, which calls
// saveCanvas(), which re-invokes the registered auto-compact trigger and
// tries to schedule a fresh timer for the same key — see disposeAutoCompact's
// loop comment below. Without this guard, that reschedule's timer and
// disposeAutoCompact's next clear-and-recheck pass race each other: whichever
// one is scheduled first on the event loop wins, and under load the timer
// can fire (starting a real compaction) before the loop gets back around to
// cancel it. disposeAutoCompact's own loop still correctly waits for a
// compaction that wins that race, so this was never a leak, but the outcome
// was nondeterministic. Refusing new timers for the whole disposal removes
// the race instead of relying on winning it.
// A counter rather than a boolean: overlapping disposeAutoCompact() calls
// (parallel DB dispose hooks, test teardown racing an explicit call) must not
// let the first finisher drop the guard while another disposal is still
// draining.
let disposingAutoCompactCount = 0

export function scheduleAutoCompact(
  workspaceId: string,
  slug: string,
  versionStore: VersionStore,
  options: { debounceMs?: number } = {},
): void {
  if (disposingAutoCompactCount > 0) return
  const key = `${workspaceId}/${slug}`
  const existing = autoCompactTimers.get(key)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    autoCompactTimers.delete(key)
    const compaction = compactCanvas(workspaceId, slug, versionStore)
      .then((result) => {
        if (result.compacted) {
          getLogger('auto-compact').info(
            {
              workspaceId,
              slug,
              beforeBytes: result.beforeBytes,
              afterBytes: result.afterBytes,
            },
            'compacted',
          )
        }
      })
      .catch((err) => {
        getLogger('auto-compact').warning({ workspaceId, slug, err }, 'failed')
      })
      .finally(() => {
        inFlightAutoCompacts.delete(compaction)
      })
    inFlightAutoCompacts.add(compaction)
  }, options.debounceMs ?? AUTO_COMPACT_DEBOUNCE_MS)
  // Do not keep the event loop alive just for this debounce. Node will
  // still flush the compaction if anything else (HTTP, WS) holds the
  // loop open; in tests we explicitly wait for the timeout.
  if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref()
  }
  autoCompactTimers.set(key, timer)
}

// Awaitable superset of setAutoCompactTrigger(null): cancels every pending
// timer AND waits for every already-fired compaction to settle, so a caller
// that awaits this is guaranteed no compactCanvas call can still reach the
// DB driver afterward. Registered as a DB dispose hook (below) so disposing
// a store's DB always drains this state first, without every dispose call
// site having to remember to call it manually. Idempotent: calling it with
// nothing pending simply resolves immediately, and scheduleAutoCompact works
// again afterward (a fresh call re-populates both trackers).
export async function disposeAutoCompact(): Promise<void> {
  disposingAutoCompactCount++
  try {
    // A single clear-then-await pass is not enough: an in-flight compaction's
    // loadCanvas() can run legacy migration, which calls saveCanvas(), which
    // re-invokes the registered auto-compact trigger *while we are still
    // awaiting the first batch*. scheduleAutoCompact refuses that reschedule
    // outright (the guard counter is non-zero for this whole call), so this
    // loop's job is just to drain whatever was already in flight or already
    // timer-scheduled before disposal began.
    for (;;) {
      clearAllAutoCompactTimers()
      const inFlight = Array.from(inFlightAutoCompacts)
      if (inFlight.length === 0) break
      await Promise.allSettled(inFlight)
    }
  } finally {
    disposingAutoCompactCount--
  }
}

// Test-only introspection, matching the `_destinationCountForTests` pattern
// in log.ts: lets tests poll for "a compaction has fired and is mid-flight"
// without a bespoke gate inside compactCanvas itself.
export function _inFlightAutoCompactCountForTests(): number {
  return inFlightAutoCompacts.size
}

// Test-only introspection: lets a test deterministically wait until
// disposeAutoCompact() has begun (and is therefore refusing reschedules)
// before triggering a reschedule attempt, instead of racing a wall-clock
// delay against dispose's await window.
export function _isDisposingAutoCompactForTests(): boolean {
  return disposingAutoCompactCount > 0
}

registerDbDisposeHook(disposeAutoCompact)

// ── list workspaces from the workspaces table ──
export async function listWorkspaces(): Promise<{ workspaceId: string }[]> {
  const db = await dbReady()
  const rows = await db.selectFrom('workspaces').select(['id', 'updatedAt']).execute()
  return rows.map((r) => ({ workspaceId: r.id }))
}

// ── rename a canvas's slug ──
// Updates only canvases.slug. branches/versions FK on canvasId and the blob
// path also uses canvasId, so none of that moves. Returns null (never
// throws) for a missing source canvas, matching deleteCanvas's boolean-
// shaped "already gone" handling; a rename onto an already-taken slug
// throws ConflictError instead of a raw unique-constraint error.
export async function renameCanvasSlug(
  workspaceId: string,
  oldSlug: string,
  newSlug: string,
): Promise<{ canvasId: string } | null> {
  validateWorkspaceId(workspaceId)
  validateSlug(oldSlug)
  validateSlug(newSlug)
  return withWorkspaceWriteLock(workspaceId, async () => {
    const db = await dbReady()
    const canvasId = await getCanvasIdBySlug(db, workspaceId, oldSlug)
    if (!canvasId) return null
    if (oldSlug === newSlug) return { canvasId }
    const taken = await getCanvasIdBySlug(db, workspaceId, newSlug)
    if (taken) {
      throw new ConflictError(`Canvas "${workspaceId}/${newSlug}" already exists`)
    }
    await db
      .updateTable('canvases')
      .set({ slug: newSlug, updatedAt: Date.now() })
      .where('id', '=', canvasId)
      .execute()
    // Force the next getDoc() to reload under both slug keys. oldSlug: a
    // caller still reading through it should lazily create a fresh canvas
    // rather than resurrect the renamed doc's cached instance. newSlug: a
    // WS connect or update-route call against the destination slug before
    // this rename can lazily cache an empty phantom doc there (getDoc()
    // creates one for any slug with no DB row yet) — leaving that phantom
    // cached would shadow the just-renamed canvas's real content and the
    // next write through newSlug would persist the phantom over it.
    const { evictDoc } = await import('./doc-cache.js')
    evictDoc(workspaceId, oldSlug)
    evictDoc(workspaceId, newSlug)
    return { canvasId }
  })
}

// ── list canvases from the canvases table ──
export async function listCanvases(
  workspaceId: string,
): Promise<Pick<CanvasSummary, 'slug' | 'id' | 'updatedAt' | 'kind'>[]> {
  validateWorkspaceId(workspaceId)
  const db = await dbReady()
  const rows = await db
    .selectFrom('canvases')
    .select(['slug', 'id', 'updatedAt', 'kind'])
    .where('workspaceId', '=', workspaceId)
    .execute()
  return rows.map((r) => ({
    slug: r.slug,
    id: r.id,
    updatedAt: new Date(r.updatedAt).toISOString(),
    kind: r.kind ?? 'spatial',
  }))
}
