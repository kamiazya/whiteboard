import { Hono } from 'hono'
import type { WebSocket } from 'ws'
import { userInfo } from 'node:os'
import { LoroDoc as LoroDocCtor, LoroMap } from 'loro-crdt'
import type { LoroDoc } from 'loro-crdt'
import { nanoid } from 'nanoid'
import {
  type CreateCanvasResponse,
  type ListCanvasesResponse,
  type ListVersionsResponse,
  type ListWorkspacesResponse,
  type SaveVersionResponse,
  createCanvasRequestSchema,
  exportCanvasJsonRequestSchema,
  restoreVersionRequestSchema,
  saveVersionRequestSchema,
  setNameRequestSchema,
  setPinnedRequestSchema,
  type UpdateCanvasResponse,
} from '../../shared/api-contracts/canvas.js'
import { reconcileElementsOnDoc } from '../../shared/reconcile-elements.js'
import { getLogger } from '../log.js'
import { getDoc, evictDoc } from '../store/doc-cache.js'
import {
  canvasExists,
  ConflictError,
  compactCanvas,
  listCanvases,
  listWorkspaces,
  saveCanvas,
  scheduleAutoCompact,
  setAutoCompactTrigger,
} from '../store/canvas-store.js'
import {
  FileVersionStore,
  type VersionStore,
  type VersionEntry,
  type OperatorInfo,
} from '../store/version-store.js'
import {
  loadWorkspaceNames,
  setWorkspaceName,
  setCanvasName,
  setCanvasPinned,
} from '../store/names-store.js'
import { corruptStoredDataBody, isCorruptStoredDataError } from '../store/corrupt-stored-data.js'
import { exportCanvasJsonDoc, OutputPathError } from '../export-json.js'
import {
  validationErrorBody,
  validateWorkspaceId,
  validateSlug,
  validateVersionId,
} from '../validators.js'
import { isValidPngSignature } from './canvas-thumbnail.js'
import { toCanvasOutputPathErrorBody } from './canvas-output-path-error.js'

// WS broadcast function injected from ws.ts.
type BroadcastFn = (
  workspaceId: string,
  slug: string,
  update: Uint8Array,
  excludeWs?: WebSocket,
) => void
let broadcastLoroUpdate: BroadcastFn = () => {}

export function setBroadcastFn(fn: BroadcastFn): void {
  broadcastLoroUpdate = fn
}

function defaultHumanDisplayName(): string {
  try {
    const name = userInfo().username.trim()
    if (name.length > 0) return name
  } catch {
    /* ignore */
  }
  return 'human'
}

// Shared auto-version debounce trigger used by both HTTP POST /update and the WS binary path.
// Tracks the last auto-save time per canvasId and returns no-op below the threshold.
const AUTO_VERSION_INTERVAL_MS = 30_000

export function createAutoVersionTrigger(
  versionStore: VersionStore,
  intervalMs: number,
  // Resolve the current HEAD branch name at save time and write it into VersionMeta.branchName.
  // If omitted or null, keep the previous behavior and let VersionStore.save fall back to "main".
  getHeadBranch?: (workspaceId: string, slug: string) => Promise<string | null>,
): (workspaceId: string, slug: string, doc: LoroDoc) => Promise<VersionEntry | null> {
  // Per-canvas last-save timestamps. In-place Map mutation is intentional: this is
  // closure-private throttle state, never shared or observed, so the immutability
  // rule (which guards shared/observable data) does not apply.
  const lastAt = new Map<string, number>()
  return async function triggerAutoVersion(workspaceId, slug, doc) {
    const key = `${workspaceId}/${slug}`
    const now = Date.now()
    if (now - (lastAt.get(key) ?? 0) < intervalMs) return null
    let branchName: string | null = null
    if (getHeadBranch) {
      try {
        branchName = await getHeadBranch(workspaceId, slug)
      } catch (err) {
        if (isCorruptStoredDataError(err)) {
          throw err
        }
        branchName = null
      }
    }
    try {
      const opts: { auto: boolean; branchName?: string; operator: OperatorInfo } = {
        auto: true,
        operator: {
          kind: 'system',
          peerId: doc.peerIdStr,
          displayName: 'auto-save',
        },
      }
      if (typeof branchName === 'string' && branchName.length > 0) {
        opts.branchName = branchName
      }
      const entry = await versionStore.save(workspaceId, slug, doc, opts)
      lastAt.set(key, now)
      return entry
    } catch (err) {
      getLogger('auto-version').error({ err: err as Error }, 'save failed')
      return null
    }
  }
}

export interface CanvasRouterOptions {
  // Allow tests to replace the store. Production uses FileVersionStore.
  versionStore?: VersionStore
  // Auto-version interval in milliseconds. Tests can reduce it.
  autoVersionIntervalMs?: number
  // Resolve the HEAD branch name for manual and auto version saves.
  // If omitted, ignore branch metadata. Production wires this from app.ts.
  getHeadBranch?: (workspaceId: string, slug: string) => Promise<string | null>
}

export function createCanvasRouter(options: CanvasRouterOptions = {}) {
  const app = new Hono()
  const handleCorruptStoredData = (
    err: unknown,
  ): { status: 500; body: { error: 'corrupt_stored_data'; message: string } } | null => {
    const body = corruptStoredDataBody(err)
    if (body) return { status: 500, body }
    return null
  }
  const versionStore = options.versionStore ?? new FileVersionStore()
  const autoInterval = options.autoVersionIntervalMs ?? AUTO_VERSION_INTERVAL_MS
  const triggerAutoVersion = createAutoVersionTrigger(
    versionStore,
    autoInterval,
    options.getHeadBranch,
  )
  // Register the same trigger with ws.ts so the WS path shares the auto-version logic.
  // Use dynamic import to avoid the ws.ts <- canvas.ts cycle evaluating in the wrong order.
  void import('./ws.js').then(({ setAutoVersionTrigger }) => {
    setAutoVersionTrigger?.(triggerAutoVersion)
  })

  // Auto-compact debounce: every successful saveCanvas reschedules a per-
  // canvas compaction. The 30s default lets active editing sessions burst
  // without thrashing the op-log; once the user pauses, the shallow-snapshot
  // runs in the background. Tests can override the trigger via
  // setAutoCompactTrigger(null) before assertions if they want to isolate
  // the save path from the compact path.
  setAutoCompactTrigger((workspaceId, slug) => {
    scheduleAutoCompact(workspaceId, slug, versionStore)
  })

  // GET /api/workspaces
  app.get('/api/workspaces', async (c) => {
    try {
      const workspaces = await listWorkspaces()
      const response: ListWorkspacesResponse = {
        workspaces: workspaces.map(({ workspaceId }) => ({ workspaceId })),
      }
      return c.json(response)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // GET /api/workspaces/:workspaceId/canvases
  app.get('/api/workspaces/:workspaceId/canvases', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const canvases = await listCanvases(workspaceId)
      const response: ListCanvasesResponse = { canvases }
      return c.json(response)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // POST /api/workspaces/:workspaceId/canvases  body: { slug: string }
  // Save a new empty LoroDoc under slug. Return 409 for conflicts and 400 for invalid slugs.
  // On success, return { slug } for client-side navigation.
  app.post('/api/workspaces/:workspaceId/canvases', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json({ title: body.message }, 400)
      throw err
    }
    const raw = await c.req.json().catch(() => null)
    if (raw === null) {
      return c.json({ title: 'JSON body required' }, 400)
    }
    const parsed = createCanvasRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({ title: 'slug is required' }, 400)
    }
    const slug = parsed.data.slug
    try {
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json({ title: body.message }, 400)
      throw err
    }
    try {
      const doc = new LoroDocCtor()
      await saveCanvas(workspaceId, slug, doc, { overwrite: false })
      const response: CreateCanvasResponse = { slug }
      return c.json(response)
    } catch (err) {
      if (err instanceof ConflictError) {
        return c.json({ title: `Canvas "${slug}" already exists` }, 409)
      }
      getLogger('canvas').error({ err: err as Error }, 'saveCanvas failed unexpectedly')
      return c.json({ title: 'Failed to create canvas.' }, 500)
    }
  })

  // User-facing workspace / canvas names.
  // When unnamed, the UI falls back to session id / slug, so the API only returns stored values.

  // GET /api/workspaces/:workspaceId/names
  app.get('/api/workspaces/:workspaceId/names', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const names = await loadWorkspaceNames(workspaceId)
      return c.json(names)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // PUT /api/workspaces/:workspaceId/name  body: { name: string } (empty string deletes)
  app.put('/api/workspaces/:workspaceId/name', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const parsed = setNameRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'invalid_body' }, 400)
    }
    try {
      const updated = await setWorkspaceName(workspaceId, parsed.data.name)
      return c.json(updated)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // PUT /api/workspaces/:workspaceId/canvases/:slug/name  body: { name: string } (empty string deletes)
  app.put('/api/workspaces/:workspaceId/canvases/:slug/name', async (c) => {
    const { workspaceId, slug } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const parsed = setNameRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'invalid_body' }, 400)
    }
    try {
      const updated = await setCanvasName(workspaceId, slug, parsed.data.name)
      return c.json(updated)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // PUT /api/workspaces/:workspaceId/canvases/:slug/pin  body: { pinned: boolean }
  // Idempotently set pin on/off and return the full updated WorkspaceNames payload.
  app.put('/api/workspaces/:workspaceId/canvases/:slug/pin', async (c) => {
    const { workspaceId, slug } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const parsed = setPinnedRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', message: 'pinned must be boolean' }, 400)
    }
    try {
      const updated = await setCanvasPinned(workspaceId, slug, parsed.data.pinned)
      return c.json(updated)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // GET /api/canvas/:workspaceId/:slug/snapshot
  app.get('/api/canvas/:workspaceId/:slug/snapshot', async (c) => {
    const { workspaceId, slug } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const doc = await getDoc(workspaceId, slug)
    const snapshot = doc.export({ mode: 'snapshot' }) as Uint8Array<ArrayBuffer>
    return c.body(snapshot, 200, {
      'Content-Type': 'application/octet-stream',
    })
  })

  // POST /api/canvas/:workspaceId/:slug/update
  app.post('/api/canvas/:workspaceId/:slug/update', async (c) => {
    const { workspaceId, slug } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer())

    const doc = await getDoc(workspaceId, slug)
    doc.import(bytes)
    await saveCanvas(workspaceId, slug, doc, { overwrite: true })

    // Broadcast to all WS clients because the originating WS context is unknown on HTTP requests.
    broadcastLoroUpdate(workspaceId, slug, bytes)

    // Trigger auto-versioning. The throttle is built in, so below-threshold calls return null.
    // Even if saving the version fails, keep this API at 200 because the update itself is the priority.
    triggerAutoVersion(workspaceId, slug, doc)
      .then(async (entry) => {
        if (!entry) return
        const { sendVersionCreated } = await import('./ws.js')
        sendVersionCreated(workspaceId, slug, entry)
      })
      .catch((err: unknown) => {
        getLogger('canvas').error({ err: err as Error }, 'auto-version trigger failed')
      })

    const response: UpdateCanvasResponse = { ok: true }
    return c.json(response)
  })

  // GET /api/workspaces/:workspaceId/canvases/:slug/versions
  // List versions for one canvas in reverse chronological order.
  app.get('/api/workspaces/:workspaceId/canvases/:slug/versions', async (c) => {
    const { workspaceId, slug } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const versions = await versionStore.list(workspaceId, slug)
      const response: ListVersionsResponse = { versions }
      return c.json(response)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // POST /api/workspaces/:workspaceId/canvases/:slug/versions
  // Save a manual version with body { label?: string; operator?: OperatorInfo }. auto is false.
  app.post('/api/workspaces/:workspaceId/canvases/:slug/versions', async (c) => {
    const { workspaceId, slug } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    // Empty body is valid (no label / operator); a non-empty body must parse as
    // JSON and pass schema validation, otherwise return invalid_body.
    const rawText = await c.req.text()
    let label: string | undefined
    let operator: OperatorInfo | undefined
    if (rawText.length > 0) {
      let json: unknown
      try {
        json = JSON.parse(rawText)
      } catch {
        return c.json({ error: 'invalid_body', message: 'malformed JSON' }, 400)
      }
      const parsed = saveVersionRequestSchema.safeParse(json)
      if (!parsed.success) {
        const message =
          parsed.error.issues[0]?.path[0] === 'operator'
            ? 'operator is invalid'
            : 'label must be string'
        return c.json({ error: 'invalid_body', message }, 400)
      }
      label = parsed.data.label
      operator = parsed.data.operator
    }
    try {
      const doc = await getDoc(workspaceId, slug)
      // Include the current HEAD branch name in manual saves too.
      let branchName: string | undefined
      if (options.getHeadBranch) {
        try {
          const head = await options.getHeadBranch(workspaceId, slug)
          if (typeof head === 'string' && head.length > 0) branchName = head
        } catch (err) {
          if (isCorruptStoredDataError(err)) {
            throw err
          }
          /* If HEAD cannot be resolved, fall back to the previous "main" behavior. */
        }
      }
      const nextOperator = operator ?? {
        kind: 'human' as const,
        peerId: doc.peerIdStr,
        displayName: defaultHumanDisplayName(),
      }
      const entry = await versionStore.save(workspaceId, slug, doc, {
        auto: false,
        ...(label !== undefined ? { label } : {}),
        ...(branchName !== undefined ? { branchName } : {}),
        operator: nextOperator,
      })
      const response: SaveVersionResponse = { version: entry }
      return c.json(response)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // POST /api/workspaces/:workspaceId/canvases/:slug/compact
  // GC the op-log before the oldest retained version frontiers using shallow-snapshot.
  // Side effects: replace the on-disk .loro file and evict doc-cache so the next getDoc reloads the shallow doc.
  // Avoid calling this frequently on highly active multi-peer canvases because concurrent applyAndPersist calls can race.
  app.post('/api/workspaces/:workspaceId/canvases/:slug/compact', async (c) => {
    const { workspaceId, slug } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const result = await compactCanvas(workspaceId, slug, versionStore)
      if (result.compacted) evictDoc(workspaceId, slug)
      return c.json(result)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // POST /api/workspaces/:workspaceId/versions/prune-sandwiched
  // Drop auto-saved versions strictly between two manual versions, per
  // canvas, per branch. Manuals are explicit user save-points; sandwiched
  // autos add no rollback value once both bracket points exist. Loops over
  // every canvas in the workspace and aggregates totals.
  app.post('/api/workspaces/:workspaceId/versions/prune-sandwiched', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const canvases = await listCanvases(workspaceId)
      const results: Array<{ slug: string; deletedCount: number }> = []
      let totalDeleted = 0
      for (const { slug } of canvases) {
        const r = await versionStore.pruneSandwichedAutoVersions(workspaceId, slug)
        results.push({ slug, deletedCount: r.deletedCount })
        totalDeleted += r.deletedCount
      }
      return c.json({ results, totalDeleted })
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // POST /api/workspaces/:workspaceId/canvases/optimize-all
  // Bulk per-canvas compact for the whole workspace. Loops sequentially to
  // keep the doc-cache coherent (each compact evicts its own slot) and
  // because the underlying Loro IO is fast enough that parallelism only
  // adds race risk. Returns a per-canvas array plus aggregated totals so
  // the UI can show a meaningful summary in one round-trip.
  app.post('/api/workspaces/:workspaceId/canvases/optimize-all', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const canvases = await listCanvases(workspaceId)
      const results: Array<{
        slug: string
        compacted: boolean
        beforeBytes: number
        afterBytes: number
        reason?: string
      }> = []
      let totalBeforeBytes = 0
      let totalAfterBytes = 0
      for (const { slug } of canvases) {
        const result = await compactCanvas(workspaceId, slug, versionStore)
        if (result.compacted) evictDoc(workspaceId, slug)
        results.push({ slug, ...result })
        totalBeforeBytes += result.beforeBytes
        totalAfterBytes += result.afterBytes
      }
      return c.json({ results, totalBeforeBytes, totalAfterBytes })
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  app.post('/api/canvas/:workspaceId/:slug/export-json', async (c) => {
    const { workspaceId, slug } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const rawText = await c.req.text()
    const body =
      rawText.length === 0
        ? exportCanvasJsonRequestSchema.parse({})
        : await (async () => {
            let json: unknown
            try {
              json = JSON.parse(rawText)
            } catch {
              return null
            }
            const parsed = exportCanvasJsonRequestSchema.safeParse(json)
            return parsed.success ? parsed.data : null
          })()
    if (body === null) {
      return c.json({ error: 'invalid_body', message: 'invalid export options' }, 400)
    }
    const includeCustomFields = body.includeCustomFields === true
    const outputPath =
      typeof body.outputPath === 'string' && body.outputPath.length > 0
        ? body.outputPath
        : undefined
    const overwrite = body.overwrite === true
    const doc = await getDoc(workspaceId, slug)
    try {
      return c.json(
        await exportCanvasJsonDoc({
          workspaceId,
          slug,
          doc,
          includeCustomFields,
          outputPath,
          overwrite,
        }),
      )
    } catch (err) {
      if (err instanceof OutputPathError) {
        const { status, body } = toCanvasOutputPathErrorBody(err, workspaceId)
        return c.json(body, status)
      }
      throw err
    }
  })

  // PUT /api/workspaces/:workspaceId/canvases/:slug/versions/:id/thumbnail
  // Body is PNG binary from the browser exportToBlob result. Validate the PNG signature minimally.
  app.put('/api/workspaces/:workspaceId/canvases/:slug/versions/:id/thumbnail', async (c) => {
    const { workspaceId, slug, id } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
      validateVersionId(id)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (!isValidPngSignature(bytes)) {
      return c.json({ error: 'invalid_png' }, 400)
    }
    try {
      await versionStore.saveThumbnail(workspaceId, id, bytes)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'save failed'
      return c.json({ error: 'save_failed', message: msg }, 400)
    }
    return c.json({ ok: true })
  })

  // GET /api/workspaces/:workspaceId/canvases/:slug/versions/:id/thumbnail
  // Return the PNG with cache headers, or 404 if it has not been saved.
  app.get('/api/workspaces/:workspaceId/canvases/:slug/versions/:id/thumbnail', async (c) => {
    const { workspaceId, slug, id } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
      validateVersionId(id)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const bytes = await versionStore.loadThumbnail(workspaceId, id)
      if (!bytes) return c.json({ error: 'not_found' }, 404)
      return c.body(bytes.buffer as ArrayBuffer, 200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600, immutable',
      })
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // GET /api/workspaces/:workspaceId/canvases/:slug/latest-thumbnail
  // Return the newest version thumbnail for canvas-switcher previews.
  // "Newest" means the first hasThumbnail=true entry in version list order (createdAt desc).
  // Keep max-age short (5 min) so fresh auto-save thumbnails replace cached ones promptly.
  app.get('/api/workspaces/:workspaceId/canvases/:slug/latest-thumbnail', async (c) => {
    const { workspaceId, slug } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const versions = await versionStore.list(workspaceId, slug)
      const latestWithThumb = versions.find((v) => v.hasThumbnail)
      // No thumbnail yet is a normal state (e.g. a brand-new canvas). This
      // endpoint backs CanvasThumb's <img src>, so a 404 would make the browser
      // log "Failed to load resource: 404" as console noise. Return 204 No
      // Content instead: a success status (no console error) whose empty body
      // still trips the <img> onError handler → the FileText placeholder.
      if (!latestWithThumb) return c.body(null, 204)
      const bytes = await versionStore.loadThumbnail(workspaceId, latestWithThumb.id)
      if (!bytes) return c.body(null, 204)
      return c.body(bytes.buffer as ArrayBuffer, 200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=300',
      })
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // POST /api/workspaces/:workspaceId/canvases/:slug/versions/:id/restore
  //
  // Two modes share this endpoint:
  //
  //   1. In-place reconcile (default; History panel uses this).
  //      CRDTs cannot forget history, so restore commits new ops that
  //      represent the past state:
  //        only in past    -> insert into current, or un-tombstone + restore fields
  //        only in current -> set isDeleted=true (tombstone)
  //        in both         -> copy differing fields from past onto current
  //
  //   2. Restore-as-new-canvas — body `{ targetSlug, overwrite? }`.
  //      Writes the past doc as a brand-new canvas under `targetSlug` in the
  //      same workspace. The original canvas / live doc / WS clients are not
  //      touched. Replaces the deleted `checkpoint_restore` flow.
  app.post('/api/workspaces/:workspaceId/canvases/:slug/versions/:id/restore', async (c) => {
    const { workspaceId, slug, id } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
      validateVersionId(id)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    // Body is optional. Empty body / non-JSON ⇒ in-place mode.
    const rawText = await c.req.text()
    let targetSlug: string | undefined
    let overwrite = false
    if (rawText.length > 0) {
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(rawText)
      } catch {
        return c.json({ error: 'invalid_body', message: 'malformed JSON' }, 400)
      }
      const parsed = restoreVersionRequestSchema.safeParse(parsedJson)
      if (!parsed.success) {
        return c.json({ error: 'invalid_body', message: 'invalid restore options' }, 400)
      }
      targetSlug = parsed.data.targetSlug
      overwrite = parsed.data.overwrite === true
    }
    try {
      const doc = await getDoc(workspaceId, slug)
      const past = await versionStore.load(workspaceId, id, doc)
      if (!past) {
        return c.json({ error: 'not_found' }, 404)
      }

      // Restore-as-new-canvas branch.
      if (targetSlug !== undefined) {
        try {
          validateSlug(targetSlug)
        } catch (err) {
          const body = validationErrorBody(err)
          if (body) return c.json(body, 400)
          throw err
        }
        try {
          await saveCanvas(workspaceId, targetSlug, past, { overwrite })
        } catch (err) {
          if (err instanceof ConflictError) {
            return c.json(
              {
                error: 'output_exists',
                message: `Target canvas "${targetSlug}" already exists. Pass overwrite=true to replace it.`,
              },
              409,
            )
          }
          throw err
        }
        evictDoc(workspaceId, targetSlug)
        return c.json({
          canvasId: `${workspaceId}/${targetSlug}`,
          elementCount: countElements(past),
        })
      }

      // In-place reconcile branch (default).
      let label: string | undefined
      const all = await versionStore.list(workspaceId, slug)
      label = all.find((v) => v.id === id)?.label
      const { sendRestoreEvent } = await import('./ws.js')
      sendRestoreEvent(workspaceId, slug, 'started', label)
      try {
        const prevVV = doc.version()
        reconcileElementsOnDoc(doc, past)
        doc.commit()
        await saveCanvas(workspaceId, slug, doc, { overwrite: true })
        const update = doc.export({ mode: 'update', from: prevVV }) as Uint8Array
        if (update.byteLength > 0) {
          broadcastLoroUpdate(workspaceId, slug, update)
        }
      } finally {
        // Always send complete, even on error, or the client overlay can stay locked forever.
        sendRestoreEvent(workspaceId, slug, 'complete')
      }
      return c.json({ ok: true })
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  return app
}

function countElements(doc: LoroDoc): number {
  try {
    const list = doc.getMovableList('elements').toJSON() as Array<{ isDeleted?: boolean }>
    return list.filter((el) => el.isDeleted !== true).length
  } catch {
    return 0
  }
}
