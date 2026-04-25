import { Hono } from 'hono'
import type { WebSocket } from 'ws'
import { userInfo } from 'node:os'
import { LoroDoc as LoroDocCtor, LoroMap } from 'loro-crdt'
import type { LoroDoc } from 'loro-crdt'
import { nanoid } from 'nanoid'
import { reconcileElementsOnDoc } from '../../shared/reconcile-elements.js'
import { getDoc, evictDoc } from '../store/doc-cache.js'
import { listSessions, listCanvases, saveCanvas, compactCanvas, ConflictError, canvasExists } from '../store/canvas-store.js'
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
  loadSessionNames,
  setWorkspaceName,
  setCanvasName,
  setCanvasPinned,
} from '../store/names-store.js'
import { corruptStoredDataBody, isCorruptStoredDataError } from '../store/corrupt-stored-data.js'
import { exportCanvasJsonDoc, OutputPathError } from '../export-json.js'
import {
  validationErrorBody,
  validateSessionId,
  validateSlug,
  validateVersionId,
} from '../validators.js'
import { registerWorkspaceAlias } from './workspace-alias.js'

// WS broadcast function injected from ws.ts.
type BroadcastFn = (sessionId: string, slug: string, update: Uint8Array, excludeWs?: WebSocket) => void
let broadcastLoroUpdate: BroadcastFn = () => {}

export function setBroadcastFn(fn: BroadcastFn): void {
  broadcastLoroUpdate = fn
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseOperatorBody(value: unknown): OperatorInfo | null {
  if (!isRecord(value)) return null
  if (value.kind !== 'ai' && value.kind !== 'human' && value.kind !== 'system') return null
  if (typeof value.peerId !== 'string' || value.peerId.trim().length === 0) return null
  if (value.displayName !== undefined && typeof value.displayName !== 'string') return null
  if (value.agentId !== undefined && typeof value.agentId !== 'string') return null
  if (value.sessionId !== undefined && typeof value.sessionId !== 'string') return null
  return {
    kind: value.kind,
    peerId: value.peerId,
    ...(value.displayName !== undefined ? { displayName: value.displayName } : {}),
    ...(value.agentId !== undefined ? { agentId: value.agentId } : {}),
    ...(value.sessionId !== undefined ? { sessionId: value.sessionId } : {}),
  }
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
  getHeadBranch?: (sessionId: string, slug: string) => Promise<string | null>,
): (sessionId: string, slug: string, doc: LoroDoc) => Promise<VersionEntry | null> {
  const lastAt = new Map<string, number>()
  return async function triggerAutoVersion(sessionId, slug, doc) {
    const key = `${sessionId}/${slug}`
    const now = Date.now()
    if (now - (lastAt.get(key) ?? 0) < intervalMs) return null
    let branchName: string | null = null
    if (getHeadBranch) {
      try {
        branchName = await getHeadBranch(sessionId, slug)
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
      const entry = await versionStore.save(sessionId, slug, doc, opts)
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
  getHeadBranch?: (sessionId: string, slug: string) => Promise<string | null>
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

  // GET /api/sessions
  app.get('/api/sessions', async (c) => {
    try {
      const sessions = await listSessions()
      return c.json({ sessions })
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  app.get('/api/workspaces', async (c) => {
    try {
      const sessions = await listSessions()
      return c.json({
        workspaces: sessions.map(({ sessionId, daemonAlive }) => ({
          workspaceId: sessionId,
          sessionId,
          daemonAlive,
        })),
      })
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // GET /api/sessions/:sessionId/canvases
  registerWorkspaceAlias(app, 'get', '/api/sessions/:sessionId/canvases', async (c) => {
    const { sessionId } = c.req.param()
    try {
      validateSessionId(sessionId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const canvases = await listCanvases(sessionId)
      return c.json({ canvases })
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // POST /api/sessions/:sessionId/canvases  body: { slug: string }
  // Save a new empty LoroDoc under slug. Return 409 for conflicts and 400 for invalid slugs.
  // On success, return { slug } for client-side navigation.
  registerWorkspaceAlias(app, 'post', '/api/sessions/:sessionId/canvases', async (c) => {
    const { sessionId } = c.req.param()
    try {
      validateSessionId(sessionId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    let slug = ''
    try {
      const body = (await c.req.json()) as { slug?: unknown }
      if (typeof body.slug !== 'string') {
        return c.json({ error: 'invalid_body', message: 'slug is required' }, 400)
      }
      slug = body.slug.trim()
      validateSlug(slug)
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON body required' }, 400)
    }
    try {
      const doc = new LoroDocCtor()
      await saveCanvas(sessionId, slug, doc, { overwrite: false })
      return c.json({ slug })
    } catch (err) {
      if (err instanceof ConflictError) {
        return c.json({ error: 'conflict', message: err.message }, 409)
      }
      const message = err instanceof Error ? err.message : 'save failed'
      return c.json({ error: 'invalid_slug', message }, 400)
    }
  })

  registerWorkspaceAlias(app, 'post', '/api/sessions/:sessionId/checkpoints', async (c) => {
    const { sessionId } = c.req.param()
    try {
      validateSessionId(sessionId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    let sourceSlug = ''
    let checkpointId = ''
    try {
      const body = (await c.req.json()) as { sourceSlug?: unknown; checkpointId?: unknown }
      if (typeof body.sourceSlug !== 'string' || body.sourceSlug.trim() === '') {
        return c.json({ error: 'invalid_body', message: 'sourceSlug is required' }, 400)
      }
      sourceSlug = body.sourceSlug.trim()
      validateSlug(sourceSlug)
      checkpointId =
        typeof body.checkpointId === 'string' && body.checkpointId.trim() !== ''
          ? body.checkpointId.trim()
          : nanoid(18)
      validateCheckpointId(checkpointId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      return c.json({ error: 'invalid_body', message: 'JSON body required' }, 400)
    }

    try {
      if (!(await canvasExists(sessionId, sourceSlug))) {
        return c.json(
          {
            error: 'not_found',
            message: `Canvas "${sessionId}/${sourceSlug}" not found.`,
          },
          404,
        )
      }
      const doc = await getDoc(sessionId, sourceSlug)
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

  // GET /api/sessions/:sessionId/names
  registerWorkspaceAlias(app, 'get', '/api/sessions/:sessionId/names', async (c) => {
    const { sessionId } = c.req.param()
    try {
      validateSessionId(sessionId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const names = await loadSessionNames(sessionId)
      return c.json(names)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // PUT /api/sessions/:sessionId/name  body: { name: string } (empty string deletes)
  registerWorkspaceAlias(app, 'put', '/api/sessions/:sessionId/name', async (c) => {
    const { sessionId } = c.req.param()
    try {
      validateSessionId(sessionId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    let name = ''
    try {
      const body = (await c.req.json()) as { name?: string }
      name = typeof body.name === 'string' ? body.name : ''
    } catch {
      return c.json({ error: 'invalid_body' }, 400)
    }
    try {
      const updated = await setWorkspaceName(sessionId, name)
      return c.json(updated)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // PUT /api/sessions/:sessionId/canvases/:slug/name  body: { name: string } (empty string deletes)
  registerWorkspaceAlias(app, 'put', '/api/sessions/:sessionId/canvases/:slug/name', async (c) => {
    const { sessionId, slug } = c.req.param()
    try {
      validateSessionId(sessionId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    let name = ''
    try {
      const body = (await c.req.json()) as { name?: string }
      name = typeof body.name === 'string' ? body.name : ''
    } catch {
      return c.json({ error: 'invalid_body' }, 400)
    }
    try {
      const updated = await setCanvasName(sessionId, slug, name)
      return c.json(updated)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // PUT /api/sessions/:sessionId/canvases/:slug/pin  body: { pinned: boolean }
  // Idempotently set pin on/off and return the full updated SessionNames payload.
  registerWorkspaceAlias(app, 'put', '/api/sessions/:sessionId/canvases/:slug/pin', async (c) => {
    const { sessionId, slug } = c.req.param()
    try {
      validateSessionId(sessionId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    let pinned: boolean
    try {
      const body = (await c.req.json()) as { pinned?: unknown }
      if (typeof body.pinned !== 'boolean') {
        return c.json({ error: 'invalid_body', message: 'pinned must be boolean' }, 400)
      }
      pinned = body.pinned
    } catch {
      return c.json({ error: 'invalid_body' }, 400)
    }
    try {
      const updated = await setCanvasPinned(sessionId, slug, pinned)
      return c.json(updated)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // GET /api/canvas/:sessionId/:slug/snapshot
  app.get('/api/canvas/:sessionId/:slug/snapshot', async (c) => {
    const { sessionId, slug } = c.req.param()
    try {
      validateSessionId(sessionId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const doc = await getDoc(sessionId, slug)
    const snapshot = doc.export({ mode: 'snapshot' }) as Uint8Array<ArrayBuffer>
    return c.body(snapshot, 200, {
      'Content-Type': 'application/octet-stream',
    })
  })

  // POST /api/canvas/:sessionId/:slug/update
  app.post('/api/canvas/:sessionId/:slug/update', async (c) => {
    const { sessionId, slug } = c.req.param()
    try {
      validateSessionId(sessionId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer())

    const doc = await getDoc(sessionId, slug)
    doc.import(bytes)
    await saveCanvas(sessionId, slug, doc, { overwrite: true })

    // Broadcast to all WS clients because the originating WS context is unknown on HTTP requests.
    broadcastLoroUpdate(sessionId, slug, bytes)

    // Trigger auto-versioning. The throttle is built in, so below-threshold calls return null.
    // Even if saving the version fails, keep this API at 200 because the update itself is the priority.
    triggerAutoVersion(sessionId, slug, doc)
      .then(async (entry) => {
        if (!entry) return
        const { sendVersionCreated } = await import('./ws.js')
        sendVersionCreated(sessionId, slug, entry)
      })
      .catch((err: unknown) => {
        console.error('[canvas] auto-version trigger failed:', err)
      })

    return c.json({ ok: true })
  })

  // GET /api/sessions/:sessionId/canvases/:slug/versions
  // List versions for one canvas in reverse chronological order.
  registerWorkspaceAlias(app, 'get', '/api/sessions/:sessionId/canvases/:slug/versions', async (c) => {
    const { sessionId, slug } = c.req.param()
    try {
      validateSessionId(sessionId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const versions = await versionStore.list(sessionId, slug)
      return c.json({ versions })
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // POST /api/sessions/:sessionId/canvases/:slug/versions
  // Save a manual version with body { label?: string; operator?: OperatorInfo }. auto is false.
  registerWorkspaceAlias(app, 'post', '/api/sessions/:sessionId/canvases/:slug/versions', async (c) => {
    const { sessionId, slug } = c.req.param()
    try {
      validateSessionId(sessionId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    let label: string | undefined
    let operator: OperatorInfo | undefined
    try {
      const body = (await c.req.json()) as { label?: unknown; operator?: unknown }
      if (body.label !== undefined) {
        if (typeof body.label !== 'string') {
          return c.json({ error: 'invalid_body', message: 'label must be string' }, 400)
        }
        label = body.label
      }
      if (body.operator !== undefined) {
        operator = parseOperatorBody(body.operator) ?? undefined
        if (!operator) {
          return c.json({ error: 'invalid_body', message: 'operator is invalid' }, 400)
        }
      }
    } catch {
      /* Treat missing or non-JSON bodies as "no label". */
    }
    try {
      const doc = await getDoc(sessionId, slug)
      // Include the current HEAD branch name in manual saves too.
      let branchName: string | undefined
      if (options.getHeadBranch) {
        try {
          const head = await options.getHeadBranch(sessionId, slug)
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
      const entry = await versionStore.save(sessionId, slug, doc, {
        auto: false,
        ...(label !== undefined ? { label } : {}),
        ...(branchName !== undefined ? { branchName } : {}),
        operator: nextOperator,
      })
      return c.json({ version: entry })
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  // POST /api/sessions/:sessionId/canvases/:slug/compact
  // GC the op-log before the oldest retained version frontiers using shallow-snapshot.
  // Side effects: replace the on-disk .loro file and evict doc-cache so the next getDoc reloads the shallow doc.
  // Avoid calling this frequently on highly active multi-peer canvases because concurrent applyAndPersist calls can race.
  registerWorkspaceAlias(app, 'post', '/api/sessions/:sessionId/canvases/:slug/compact', async (c) => {
    const { sessionId, slug } = c.req.param()
    try {
      validateSessionId(sessionId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const result = await compactCanvas(sessionId, slug, versionStore)
      if (result.compacted) evictDoc(sessionId, slug)
      return c.json(result)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  registerWorkspaceAlias(app, 'post', '/api/sessions/:sessionId/checkpoints/:checkpointId/restore', async (c) => {
    const { sessionId, checkpointId } = c.req.param()
    try {
      validateSessionId(sessionId)
      validateCheckpointId(checkpointId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    let targetSlug = ''
    let overwrite = false
    try {
      const body = (await c.req.json()) as { targetSlug?: unknown; overwrite?: unknown }
      if (typeof body.targetSlug !== 'string' || body.targetSlug.trim() === '') {
        return c.json({ error: 'invalid_body', message: 'targetSlug is required' }, 400)
      }
      targetSlug = body.targetSlug.trim()
      validateSlug(targetSlug)
      overwrite = body.overwrite === true
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON body required' }, 400)
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
      await saveCanvas(sessionId, targetSlug, doc, { overwrite })
      evictDoc(sessionId, targetSlug)
      return c.json({
        canvasId: `${sessionId}/${targetSlug}`,
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

  app.post('/api/canvas/:sessionId/:slug/export-json', async (c) => {
    const { sessionId, slug } = c.req.param()
    try {
      validateSessionId(sessionId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    let includeCustomFields = false
    let outputPath: string | undefined
    let overwrite = false
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        includeCustomFields?: unknown
        outputPath?: unknown
        overwrite?: unknown
      }
      includeCustomFields = body.includeCustomFields === true
      if (typeof body.outputPath === 'string' && body.outputPath.length > 0) {
        outputPath = body.outputPath
      }
      overwrite = body.overwrite === true
    } catch {
      /* empty body -> defaults */
    }
    const doc = await getDoc(sessionId, slug)
    try {
      return c.json(
        await exportCanvasJsonDoc({
          sessionId,
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

  // PUT /api/sessions/:sessionId/canvases/:slug/versions/:id/thumbnail
  // Body is PNG binary from the browser exportToBlob result. Validate the PNG signature minimally.
  registerWorkspaceAlias(
    app,
    'put',
    '/api/sessions/:sessionId/canvases/:slug/versions/:id/thumbnail',
    async (c) => {
    const { sessionId, slug, id } = c.req.param()
    try {
      validateSessionId(sessionId)
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
      await versionStore.saveThumbnail(sessionId, id, bytes)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'save failed'
      return c.json({ error: 'save_failed', message: msg }, 400)
    }
    return c.json({ ok: true })
  })

  // GET /api/sessions/:sessionId/canvases/:slug/versions/:id/thumbnail
  // Return the PNG with cache headers, or 404 if it has not been saved.
  registerWorkspaceAlias(
    app,
    'get',
    '/api/sessions/:sessionId/canvases/:slug/versions/:id/thumbnail',
    async (c) => {
    const { sessionId, slug, id } = c.req.param()
    try {
      validateSessionId(sessionId)
      validateSlug(slug)
      validateVersionId(id)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const bytes = await versionStore.loadThumbnail(sessionId, id)
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

  // GET /api/sessions/:sessionId/canvases/:slug/latest-thumbnail
  // Return the newest version thumbnail for canvas-switcher previews.
  // "Newest" means the first hasThumbnail=true entry in version list order (createdAt desc).
  // Keep max-age short (5 min) so fresh auto-save thumbnails replace cached ones promptly.
  registerWorkspaceAlias(app, 'get', '/api/sessions/:sessionId/canvases/:slug/latest-thumbnail', async (c) => {
    const { sessionId, slug } = c.req.param()
    try {
      validateSessionId(sessionId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const versions = await versionStore.list(sessionId, slug)
      const latestWithThumb = versions.find((v) => v.hasThumbnail)
      if (!latestWithThumb) return c.json({ error: 'not_found' }, 404)
      const bytes = await versionStore.loadThumbnail(sessionId, latestWithThumb.id)
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

  // POST /api/sessions/:sessionId/canvases/:slug/versions/:id/restore
  // Loro-native restore reconciles current elements against the checked-out past state.
  // CRDTs cannot forget history, so restore commits new ops that represent the past state:
  //   only in past    -> insert into current, or un-tombstone and restore fields
  //   only in current -> set isDeleted=true (tombstone)
  //   in both         -> copy differing fields from past onto current
  registerWorkspaceAlias(
    app,
    'post',
    '/api/sessions/:sessionId/canvases/:slug/versions/:id/restore',
    async (c) => {
    const { sessionId, slug, id } = c.req.param()
    try {
      validateSessionId(sessionId)
      validateSlug(slug)
      validateVersionId(id)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const doc = await getDoc(sessionId, slug)
      const past = await versionStore.load(sessionId, id, doc)
      if (!past) {
        return c.json({ error: 'not_found' }, 404)
      }
      let label: string | undefined
      const all = await versionStore.list(sessionId, slug)
      label = all.find((v) => v.id === id)?.label
      const { sendRestoreEvent } = await import('./ws.js')
      sendRestoreEvent(sessionId, slug, 'started', label)
      try {
        const prevVV = doc.version()
        reconcileElementsOnDoc(doc, past)
        doc.commit()
        await saveCanvas(sessionId, slug, doc, { overwrite: true })
        const update = doc.export({ mode: 'update', from: prevVV }) as Uint8Array
        if (update.byteLength > 0) {
          broadcastLoroUpdate(sessionId, slug, update)
        }
      } finally {
        // Always send complete, even on error, or the client overlay can stay locked forever.
        sendRestoreEvent(sessionId, slug, 'complete')
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
