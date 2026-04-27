import { Hono } from 'hono'
import type { WebSocket } from 'ws'
import { userInfo } from 'node:os'
import { LoroDoc as LoroDocCtor, LoroMap } from 'loro-crdt'
import type { LoroDoc } from 'loro-crdt'
import { nanoid } from 'nanoid'
import {
  type ListCanvasesResponse,
  type ListVersionsResponse,
  type ListWorkspacesResponse,
  type SaveVersionResponse,
  createCanvasRequestSchema,
  createCheckpointRequestSchema,
  exportCanvasJsonRequestSchema,
  restoreCheckpointRequestSchema,
  saveVersionRequestSchema,
  setNameRequestSchema,
  setPinnedRequestSchema,
} from '../../shared/api-contracts/canvas.js'
import { reconcileElementsOnDoc } from '../../shared/reconcile-elements.js'
import { getDoc, evictDoc } from '../store/doc-cache.js'
import { listWorkspaces, listCanvases, saveCanvas, compactCanvas, ConflictError, canvasExists } from '../store/canvas-store.js'
import {
  FileVersionStore,
  type VersionStore,
  type VersionEntry,
  type OperatorInfo,
} from '../store/version-store.js'
import {
  FileCheckpointStore,
  type CheckpointStore,
  validateCheckpointId,
} from '../store/checkpoint-store.js'
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

// WS broadcast function injected from ws.ts.
type BroadcastFn = (workspaceId: string, slug: string, update: Uint8Array, excludeWs?: WebSocket) => void
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
      console.error('[auto-version] save failed:', err)
      return null
    }
  }
}

export interface CanvasRouterOptions {
  // Allow tests to replace the store. Production uses FileVersionStore.
  versionStore?: VersionStore
  checkpointStore?: CheckpointStore
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
  const checkpointStore = options.checkpointStore ?? new FileCheckpointStore()
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

  // GET /api/workspaces
  app.get('/api/workspaces', async (c) => {
    try {
      const workspaces = await listWorkspaces()
      const response: ListWorkspacesResponse = {
        workspaces: workspaces.map(({ workspaceId, daemonAlive }) => ({
          workspaceId,
          daemonAlive,
        })),
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
      if (body) return c.json(body, 400)
      throw err
    }
    const raw = await c.req.json().catch(() => null)
    if (raw === null) {
      return c.json({ error: 'invalid_body', message: 'JSON body required' }, 400)
    }
    const parsed = createCanvasRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', message: 'slug is required' }, 400)
    }
    const slug = parsed.data.slug
    try {
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const doc = new LoroDocCtor()
      await saveCanvas(workspaceId, slug, doc, { overwrite: false })
      return c.json({ slug })
    } catch (err) {
      if (err instanceof ConflictError) {
        return c.json({ error: 'conflict', message: err.message }, 409)
      }
      const message = err instanceof Error ? err.message : 'save failed'
      return c.json({ error: 'invalid_slug', message }, 400)
    }
  })

  app.post('/api/workspaces/:workspaceId/checkpoints', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const raw = await c.req.json().catch(() => null)
    if (raw === null) {
      return c.json({ error: 'invalid_body', message: 'JSON body required' }, 400)
    }
    const parsed = createCheckpointRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', message: 'sourceSlug is required' }, 400)
    }
    const sourceSlug = parsed.data.sourceSlug
    const checkpointId = parsed.data.checkpointId ?? nanoid(18)
    try {
      validateSlug(sourceSlug)
      validateCheckpointId(checkpointId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }

    try {
      if (!(await canvasExists(workspaceId, sourceSlug))) {
        return c.json(
          {
            error: 'not_found',
            message: `Canvas "${workspaceId}/${sourceSlug}" not found.`,
          },
          404,
        )
      }
      const doc = await getDoc(workspaceId, sourceSlug)
      await checkpointStore.save(checkpointId, doc)
      return c.json({
        checkpointId,
        elementCount: countElements(doc),
      })
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      const message = err instanceof Error ? err.message : 'checkpoint save failed'
      return c.json({ error: 'checkpoint_save_failed', message }, 500)
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
        console.error('[canvas] auto-version trigger failed:', err)
      })

    return c.json({ ok: true })
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
    // Treat missing or non-JSON bodies as "no label / operator".
    const raw = await c.req.json().catch(() => null)
    let label: string | undefined
    let operator: OperatorInfo | undefined
    if (raw !== null) {
      const parsed = saveVersionRequestSchema.safeParse(raw)
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

  app.post('/api/workspaces/:workspaceId/checkpoints/:checkpointId/restore', async (c) => {
    const { workspaceId, checkpointId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateCheckpointId(checkpointId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const raw = await c.req.json().catch(() => null)
    if (raw === null) {
      return c.json({ error: 'invalid_body', message: 'JSON body required' }, 400)
    }
    const parsed = restoreCheckpointRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', message: 'targetSlug is required' }, 400)
    }
    const targetSlug = parsed.data.targetSlug
    const overwrite = parsed.data.overwrite === true
    try {
      validateSlug(targetSlug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }

    try {
      const doc = await checkpointStore.load(checkpointId)
      if (!doc) {
        return c.json(
          {
            error: 'not_found',
            message: `Checkpoint "${checkpointId}" not found — it may have been pruned (>100) or never created.`,
          },
          404,
        )
      }
      await saveCanvas(workspaceId, targetSlug, doc, { overwrite })
      evictDoc(workspaceId, targetSlug)
      return c.json({
        canvasId: `${workspaceId}/${targetSlug}`,
        elementCount: countElements(doc),
      })
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      const message = err instanceof Error ? err.message : 'restore failed'
      return c.json({ error: 'restore_failed', message }, 500)
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
    const parsed = exportCanvasJsonRequestSchema.safeParse(
      await c.req.json().catch(() => ({})),
    )
    const body = parsed.success ? parsed.data : {}
    const includeCustomFields = body.includeCustomFields === true
    const outputPath =
      typeof body.outputPath === 'string' && body.outputPath.length > 0 ? body.outputPath : undefined
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
        const status = err.code === 'output_exists' ? 409 : 400
        return c.json({ error: err.code, message: err.message }, status)
      }
      throw err
    }
  })

  // PUT /api/workspaces/:workspaceId/canvases/:slug/versions/:id/thumbnail
  // Body is PNG binary from the browser exportToBlob result. Validate the PNG signature minimally.
  app.put(
    '/api/workspaces/:workspaceId/canvases/:slug/versions/:id/thumbnail',
    async (c) => {
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
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (
      bytes.length < 8 ||
      bytes[0] !== 0x89 ||
      bytes[1] !== 0x50 ||
      bytes[2] !== 0x4e ||
      bytes[3] !== 0x47
    ) {
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
  app.get(
    '/api/workspaces/:workspaceId/canvases/:slug/versions/:id/thumbnail',
    async (c) => {
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
      if (!latestWithThumb) return c.json({ error: 'not_found' }, 404)
      const bytes = await versionStore.loadThumbnail(workspaceId, latestWithThumb.id)
      if (!bytes) return c.json({ error: 'not_found' }, 404)
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
  // Loro-native restore reconciles current elements against the checked-out past state.
  // CRDTs cannot forget history, so restore commits new ops that represent the past state:
  //   only in past    -> insert into current, or un-tombstone and restore fields
  //   only in current -> set isDeleted=true (tombstone)
  //   in both         -> copy differing fields from past onto current
  app.post(
    '/api/workspaces/:workspaceId/canvases/:slug/versions/:id/restore',
    async (c) => {
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
      const doc = await getDoc(workspaceId, slug)
      const past = await versionStore.load(workspaceId, id, doc)
      if (!past) {
        return c.json({ error: 'not_found' }, 404)
      }
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
