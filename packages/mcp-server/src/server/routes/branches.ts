import { Hono } from 'hono'
import {
  BranchConflictError,
  BranchNotFoundError,
  createBranch,
  deleteBranch,
  loadCanvasBranches,
  renameBranch,
  saveCanvasBranches,
} from '../store/branches-store.js'
import { corruptStoredDataBody } from '../store/corrupt-stored-data.js'
import {
  validateBranchName,
  validateSessionId,
  validateSlug,
  validateVersionId,
  validationErrorBody,
} from '../validators.js'
import { registerWorkspaceAlias } from './workspace-alias.js'

// Branches router, spec §4.
// Resolve fromVersionId through DI (resolveFromVersionFrontiers) to avoid a circular dependency.
// The caller (server/index.ts) passes a resolver that closes over FileVersionStore.

export interface CreateBranchesRouterOptions {
  // Return base64 frontiers for sessionId + versionId, or null if not found.
  // When omitted, create requests using fromVersionId always return 404.
  resolveFromVersionFrontiers?: (sessionId: string, versionId: string) => Promise<string | null>
  // Hook for PUT /head to persist the current frontiers onto the previous branch before switching.
  // Skip the update if omitted or if it returns null, for example when the doc is not cached.
  getCurrentFrontiers?: (sessionId: string, slug: string) => Promise<string | null>
  // Hook for PUT /head to reconcile and broadcast the doc to the new branch tipFrontiers.
  // Not called when tipFrontiersBase64 === "" because that branch is still uninitialized.
  checkoutTo?: (
    sessionId: string,
    slug: string,
    tipFrontiersBase64: string,
  ) => Promise<void>
  // Notify all peers on the same key when a HEAD switch completes.
  // This is only a UI signal because checkoutTo already broadcasts the Loro update.
  notifyHeadChanged?: (sessionId: string, slug: string, head: string) => void
  // Merge source into target.
  // dryRun=true returns preview + badges without persisting changes.
  // dryRun=false updates target tipFrontiers and, if target is HEAD, reconciles and broadcasts the live doc.
  // Deployments without this hook return 501 unsupported_merge.
  performMerge?: (
    sessionId: string,
    slug: string,
    args: { source: string; into: string; dryRun: boolean },
  ) => Promise<{
    previewElementCount: number
    // Optional target/source counts for the three MergeDialog columns.
    targetElementCount?: number
    sourceElementCount?: number
    badges: Array<Record<string, unknown>>
    committed: boolean
    // For dry runs, include alive elements so MergeDialog can render a read-only preview.
    previewElements?: unknown[]
    // Element ids for post-merge UI highlighting.
    newElementIds?: string[]
    changedElementIds?: string[]
    conflictElementIds?: string[]
    // Version id of the pre-merge snapshot used for undo after commit.
    preMergeVersionId?: string
    // Post-merge cleanup metadata returned by app.ts.
    switchedHead?: { from: string; to: string }
    deletedSource?: string
  }>
  // Keep version-store branchName values in sync during PATCH /branches/:name rename.
  // If omitted, only branch metadata is renamed.
  renameInVersions?: (
    sessionId: string,
    slug: string,
    oldName: string,
    newName: string,
  ) => Promise<number>
  // Count function used by DELETE /branches/:name to return actual unmergedCommits.
  // If omitted, the route falls back to 0.
  countVersionsOnBranch?: (
    sessionId: string,
    slug: string,
    branchName: string,
  ) => Promise<number>
}

// Helper that turns ValidationError into a structured 400 response.
// Re-throw everything else so the caller can handle it as a 500.
function handleValidation(err: unknown): { status: 400; body: { error: string; message: string } } | null {
  const body = validationErrorBody(err)
  if (body) return { status: 400, body }
  return null
}

function handleCorruption(
  err: unknown,
): { status: 500; body: { error: 'corrupt_stored_data'; message: string } } | null {
  const body = corruptStoredDataBody(err)
  if (body) return { status: 500, body }
  return null
}

// Helper that runs validators.validateBranchName and returns a structured 400 on ValidationError.
function validateBranchNameOrRespond(
  name: string,
): { status: 400; body: { error: string; message: string } } | null {
  try {
    validateBranchName(name)
    return null
  } catch (err) {
    const body = validationErrorBody(err)
    if (body) return { status: 400, body }
    throw err
  }
}

export function createBranchesRouter(options: CreateBranchesRouterOptions = {}) {
  const app = new Hono()
  const resolveFromVersionFrontiers = options.resolveFromVersionFrontiers
  const getCurrentFrontiers = options.getCurrentFrontiers
  const checkoutTo = options.checkoutTo
  const notifyHeadChanged = options.notifyHeadChanged
  const performMerge = options.performMerge
  const renameInVersions = options.renameInVersions
  const countVersionsOnBranch = options.countVersionsOnBranch
  const branchConflict = (message: string) => ({ error: 'branch_conflict', message })
  const branchNotFound = (message: string) => ({ error: 'branch_not_found', message })

  // ── GET /api/sessions/:sid/canvases/:slug/branches ──
  registerWorkspaceAlias(app, 'get', '/api/sessions/:sid/canvases/:slug/branches', async (c) => {
    const { sid, slug } = c.req.param()
    try {
      validateSessionId(sid)
      validateSlug(slug)
    } catch (err) {
      const v = handleValidation(err)
      if (v) return c.json(v.body, v.status)
      throw err
    }
    try {
      const state = await loadCanvasBranches(sid, slug)
      return c.json(state)
    } catch (err) {
      const corruption = handleCorruption(err)
      if (corruption) return c.json(corruption.body, corruption.status)
      throw err
    }
  })

  // ── POST /api/sessions/:sid/canvases/:slug/branches ──
  registerWorkspaceAlias(app, 'post', '/api/sessions/:sid/canvases/:slug/branches', async (c) => {
    const { sid, slug } = c.req.param()
    try {
      validateSessionId(sid)
      validateSlug(slug)
    } catch (err) {
      const v = handleValidation(err)
      if (v) return c.json(v.body, v.status)
      throw err
    }
    const body = await c.req
      .json<{ name?: unknown; fromVersionId?: unknown; color?: unknown }>()
      .catch(() => null)
    if (body === null) {
      return c.json({ error: 'invalid_body', message: 'JSON body required' }, 400)
    }
    if (typeof body.name !== 'string' || body.name.length === 0) {
      return c.json({ error: 'invalid_body', message: 'name is required' }, 400)
    }
    const nameValidation = validateBranchNameOrRespond(body.name)
    if (nameValidation) return c.json(nameValidation.body, nameValidation.status)

    let initialTipFrontiers: string | undefined
    let baseVersionId: string | undefined
    if (body.fromVersionId !== undefined) {
      if (typeof body.fromVersionId !== 'string' || body.fromVersionId.length === 0) {
        return c.json(
          { error: 'invalid_body', message: 'fromVersionId must be a non-empty string' },
          400,
        )
      }
      if (!resolveFromVersionFrontiers) {
        return c.json(
          {
            error: 'unsupported_from_version',
            message: 'fromVersionId is not supported in this deployment',
          },
          400,
        )
      }
      try {
        validateVersionId(body.fromVersionId)
      } catch (err) {
        const v = handleValidation(err)
        if (v) return c.json(v.body, v.status)
        throw err
      }
      const resolved = await resolveFromVersionFrontiers(sid, body.fromVersionId)
      if (resolved === null) {
        return c.json(branchNotFound(`Version "${body.fromVersionId}" not found`), 404)
      }
      initialTipFrontiers = resolved
      baseVersionId = body.fromVersionId
    }

    try {
      const branch = await createBranch(sid, slug, {
        name: body.name,
        ...(initialTipFrontiers !== undefined ? { initialTipFrontiers } : {}),
        ...(baseVersionId !== undefined ? { baseVersionId } : {}),
        ...(typeof body.color === 'string' ? { color: body.color } : {}),
      })
      return c.json({ branch }, 201)
    } catch (err) {
      const v = handleValidation(err)
      if (v) return c.json(v.body, v.status)
      const corruption = handleCorruption(err)
      if (corruption) return c.json(corruption.body, corruption.status)
      if (err instanceof BranchConflictError) {
        return c.json(branchConflict(err.message), 409)
      }
      throw err
    }
  })

  // ── DELETE /api/sessions/:sid/canvases/:slug/branches/:name ──
  registerWorkspaceAlias(app, 'delete', '/api/sessions/:sid/canvases/:slug/branches/:name', async (c) => {
    const { sid, slug, name } = c.req.param()
    try {
      validateSessionId(sid)
      validateSlug(slug)
    } catch (err) {
      const v = handleValidation(err)
      if (v) return c.json(v.body, v.status)
      throw err
    }
    const bn = validateBranchNameOrRespond(name)
    if (bn) return c.json(bn.body, bn.status)
    try {
      let unmerged = 0
      if (countVersionsOnBranch) {
        unmerged = await countVersionsOnBranch(sid, slug, name)
      }
      const result = await deleteBranch(sid, slug, name)
      return c.json({ ...result, unmergedCommits: unmerged })
    } catch (err) {
      const v = handleValidation(err)
      if (v) return c.json(v.body, v.status)
      const corruption = handleCorruption(err)
      if (corruption) return c.json(corruption.body, corruption.status)
      if (err instanceof BranchConflictError) {
        return c.json(branchConflict(err.message), 409)
      }
      if (err instanceof BranchNotFoundError) {
        return c.json(branchNotFound(err.message), 404)
      }
      throw err
    }
  })

  // ── PUT /api/sessions/:sid/canvases/:slug/head ──
  // Update branches.json on HEAD switch.
  // When getCurrentFrontiers / checkoutTo are provided, also:
  //   1) save the current doc.frontiers() onto the previous HEAD
  //   2) reconcile + broadcast when the new HEAD tipFrontiers is non-empty
  registerWorkspaceAlias(app, 'put', '/api/sessions/:sid/canvases/:slug/head', async (c) => {
    const { sid, slug } = c.req.param()
    try {
      validateSessionId(sid)
      validateSlug(slug)
    } catch (err) {
      const v = handleValidation(err)
      if (v) return c.json(v.body, v.status)
      throw err
    }
    const body = await c.req
      .json<{ branch?: unknown }>()
      .catch(() => null)
    if (body === null) {
      return c.json({ error: 'invalid_body', message: 'JSON body required' }, 400)
    }
    if (typeof body.branch !== 'string' || body.branch.length === 0) {
      return c.json({ error: 'invalid_body', message: 'branch is required' }, 400)
    }
    const bn = validateBranchNameOrRespond(body.branch)
    if (bn) return c.json(bn.body, bn.status)
    try {
      // Read current state first so switching to the same HEAD can short-circuit without side effects.
      const before = await loadCanvasBranches(sid, slug)
      if (!before.branches.some((b) => b.name === body.branch)) {
        throw new BranchNotFoundError(`Branch "${body.branch}" not found on ${sid}/${slug}`)
      }
      if (before.head === body.branch) {
        return c.json({ head: body.branch, previousHead: before.head })
      }

      // First ensure current-frontiers read and target checkout succeed.
      // Only then write branches.json once, avoiding partial writes on corruption.
      let currentFrontiers: string | null = null
      if (getCurrentFrontiers) {
        currentFrontiers = await getCurrentFrontiers(sid, slug)
      }

      // Reconcile to the new HEAD tipFrontiers only when non-empty.
      // checkoutTo handles strict prevalidation.
      const newTip = before.branches.find((b) => b.name === body.branch)?.tipFrontiers ?? ''
      if (checkoutTo) {
        if (newTip.length > 0) {
          await checkoutTo(sid, slug, newTip)
        }
      }

      const next = {
        head: body.branch,
        branches: before.branches.map((branch) => {
          if (branch.name !== before.head || currentFrontiers === null) return branch
          return { ...branch, tipFrontiers: currentFrontiers }
        }),
      }
      await saveCanvasBranches(sid, slug, next)
      const result = { head: body.branch, previousHead: before.head }

      // Notify all peers on the same key that HEAD changed.
      // checkoutTo may already have broadcast state, but the UI still needs an explicit
      // semantic signal that the active HEAD switched.
      if (notifyHeadChanged) {
        notifyHeadChanged(sid, slug, body.branch)
      }

      return c.json(result)
    } catch (err) {
      const v = handleValidation(err)
      if (v) return c.json(v.body, v.status)
      const corruption = handleCorruption(err)
      if (corruption) return c.json(corruption.body, corruption.status)
      if (err instanceof BranchNotFoundError) {
        return c.json(branchNotFound(err.message), 404)
      }
      throw err
    }
  })

  // ── POST /api/sessions/:sid/canvases/:slug/branches/:source/merge ──
  // Spec §7. Merge source (URL param) into target (body). dryRun can return a preview without committing.
  // LWW edge-case detection lives in merge-engine.detectMergeBadges; document operations are delegated to performMerge.
  registerWorkspaceAlias(
    app,
    'post',
    '/api/sessions/:sid/canvases/:slug/branches/:source/merge',
    async (c) => {
    const { sid, slug, source } = c.req.param()
    try {
      validateSessionId(sid)
      validateSlug(slug)
    } catch (err) {
      const v = handleValidation(err)
      if (v) return c.json(v.body, v.status)
      throw err
    }
    const srcValidation = validateBranchNameOrRespond(source)
    if (srcValidation) return c.json(srcValidation.body, srcValidation.status)

    const body = await c.req
      .json<{ into?: unknown; dryRun?: unknown }>()
      .catch(() => null)
    if (body === null) {
      return c.json({ error: 'invalid_body', message: 'JSON body required' }, 400)
    }
    if (typeof body.into !== 'string' || body.into.length === 0) {
      return c.json({ error: 'invalid_body', message: 'into is required' }, 400)
    }
    const intoValidation = validateBranchNameOrRespond(body.into)
    if (intoValidation) return c.json(intoValidation.body, intoValidation.status)

    if (source === body.into) {
      return c.json(
        { error: 'invalid_body', message: 'source and into must differ' },
        400,
      )
    }

    if (!performMerge) {
      return c.json(
        { error: 'unsupported_merge', message: 'merge is not supported in this deployment' },
        501,
      )
    }

    const dryRun = body.dryRun === true
    try {
      const result = await performMerge(sid, slug, { source, into: body.into, dryRun })
      const payload: Record<string, unknown> = { badges: result.badges }
      if (result.committed) {
        payload.committed = { elementCount: result.previewElementCount }
      } else {
        payload.preview = { elementCount: result.previewElementCount }
      }
      // Optional target/source counts for the three-column UI.
      if (typeof result.targetElementCount === 'number') {
        payload.target = { elementCount: result.targetElementCount }
      }
      if (typeof result.sourceElementCount === 'number') {
        payload.source = { elementCount: result.sourceElementCount }
      }
      // For dry runs, return the preview scene so MergeDialog can render Excalidraw.
      // After commit, the updated HEAD already drives the canvas state.
      if (!result.committed && Array.isArray(result.previewElements)) {
        payload.previewElements = result.previewElements
      }
      // Include commit metadata used by UI highlighting and undo.
      if (result.committed) {
        if (Array.isArray(result.newElementIds)) payload.newElementIds = result.newElementIds
        if (Array.isArray(result.changedElementIds))
          payload.changedElementIds = result.changedElementIds
        if (Array.isArray(result.conflictElementIds))
          payload.conflictElementIds = result.conflictElementIds
        if (typeof result.preMergeVersionId === 'string')
          payload.preMergeVersionId = result.preMergeVersionId
        if (result.switchedHead) payload.switchedHead = result.switchedHead
        if (typeof result.deletedSource === 'string')
          payload.deletedSource = result.deletedSource
      }
      return c.json(payload)
    } catch (err) {
      const v = handleValidation(err)
      if (v) return c.json(v.body, v.status)
      const corruption = handleCorruption(err)
      if (corruption) return c.json(corruption.body, corruption.status)
      if (err instanceof BranchNotFoundError || (err as Error).name === 'BranchNotFoundError') {
        return c.json(branchNotFound((err as Error).message), 404)
      }
      if (err instanceof BranchConflictError || (err as Error).name === 'BranchConflictError') {
        return c.json(branchConflict((err as Error).message), 409)
      }
      throw err
    }
  })

  // ── GET /api/sessions/:sid/canvases/:slug/branches/:name/stats ──
  // Pre-check endpoint for the delete confirmation dialog.
  // Returns actual unmergedCommits plus isHead.
  registerWorkspaceAlias(app, 'get', '/api/sessions/:sid/canvases/:slug/branches/:name/stats', async (c) => {
    const { sid, slug, name } = c.req.param()
    try {
      validateSessionId(sid)
      validateSlug(slug)
    } catch (err) {
      const v = handleValidation(err)
      if (v) return c.json(v.body, v.status)
      throw err
    }
    const bn = validateBranchNameOrRespond(name)
    if (bn) return c.json(bn.body, bn.status)
    try {
      const state = await loadCanvasBranches(sid, slug)
      if (!state.branches.some((b) => b.name === name)) {
        return c.json(branchNotFound(`Branch "${name}" not found on ${sid}/${slug}`), 404)
      }
      const isHead = state.head === name
      const unmergedCommits = countVersionsOnBranch
        ? await countVersionsOnBranch(sid, slug, name)
        : 0
      return c.json({ unmergedCommits, isHead })
    } catch (err) {
      const corrupt = handleCorruption(err)
      if (corrupt) return c.json(corrupt.body, corrupt.status)
      throw err
    }
  })

  // ── PATCH /api/sessions/:sid/canvases/:slug/branches/:name ──
  // Rename with body { name: newName }. main returns 409, conflicts return 409, missing returns 404.
  // version-store branchName updates are delegated to renameInVersions and default to 0 when omitted.
  registerWorkspaceAlias(app, 'patch', '/api/sessions/:sid/canvases/:slug/branches/:name', async (c) => {
    const { sid, slug, name } = c.req.param()
    try {
      validateSessionId(sid)
      validateSlug(slug)
    } catch (err) {
      const v = handleValidation(err)
      if (v) return c.json(v.body, v.status)
      throw err
    }
    const oldValidation = validateBranchNameOrRespond(name)
    if (oldValidation) return c.json(oldValidation.body, oldValidation.status)

    const body = await c.req
      .json<{ name?: unknown }>()
      .catch(() => null)
    if (body === null) {
      return c.json({ error: 'invalid_body', message: 'JSON body required' }, 400)
    }
    if (typeof body.name !== 'string' || body.name.length === 0) {
      return c.json({ error: 'invalid_body', message: 'name is required' }, 400)
    }
    const newValidation = validateBranchNameOrRespond(body.name)
    if (newValidation) return c.json(newValidation.body, newValidation.status)

    try {
      const branch = await renameBranch(sid, slug, name, body.name)
      let renamedVersionCount = 0
      if (renameInVersions) {
        try {
          renamedVersionCount = await renameInVersions(sid, slug, name, body.name)
        } catch (err) {
          try {
            await renameBranch(sid, slug, body.name, name)
          } catch {
            /* rollback best-effort; original error is returned */
          }
          throw err
        }
      }
      return c.json({ branch, renamedVersionCount })
    } catch (err) {
      const v = handleValidation(err)
      if (v) return c.json(v.body, v.status)
      const corrupt = handleCorruption(err)
      if (corrupt) return c.json(corrupt.body, corrupt.status)
      if (err instanceof BranchConflictError || (err as Error).name === 'BranchConflictError') {
        return c.json(branchConflict((err as Error).message), 409)
      }
      if (err instanceof BranchNotFoundError || (err as Error).name === 'BranchNotFoundError') {
        return c.json(branchNotFound((err as Error).message), 404)
      }
      throw err
    }
  })

  return app
}
