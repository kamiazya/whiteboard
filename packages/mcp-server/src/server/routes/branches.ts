import { Hono } from 'hono'
import {
  type BranchStatsResponse,
  type CanvasBranchesState,
  type CreateBranchResponse,
  createBranchRequestSchema,
  type DeleteBranchResponse,
  type MergeResponse,
  mergeRequestSchema,
  type RenameBranchResponse,
  renameBranchRequestSchema,
  type SetHeadResponse,
  setHeadRequestSchema,
} from '../../shared/api-contracts/branches.js'
import {
  BranchConflictError,
  BranchNotFoundError,
  createBranch,
  deleteBranch,
  loadCanvasBranches,
  renameBranch,
  withCanvasBranchesLock,
} from '../store/branches-store.js'
import { corruptStoredDataBody } from '../store/corrupt-stored-data.js'
import {
  validateBranchName,
  validateSlug,
  validateVersionId,
  validateWorkspaceId,
  validationErrorBody,
} from '../validators.js'

// Branches router, spec §4.
// Resolve fromVersionId through DI (resolveFromVersionFrontiers) to avoid a circular dependency.
// The caller (server/index.ts) passes a resolver that closes over FileVersionStore.

export interface CreateBranchesRouterOptions {
  // Return base64 frontiers for workspaceId + versionId, or null if not found.
  // When omitted, create requests using fromVersionId always return 404.
  resolveFromVersionFrontiers?: (workspaceId: string, versionId: string) => Promise<string | null>
  // Hook for PUT /head to persist the current frontiers onto the previous branch before switching.
  // Skip the update if omitted or if it returns null, for example when the doc is not cached.
  getCurrentFrontiers?: (workspaceId: string, slug: string) => Promise<string | null>
  // Hook for PUT /head to reconcile and broadcast the doc to the new branch tipFrontiers.
  // Not called when tipFrontiersBase64 === "" because that branch is still uninitialized.
  checkoutTo?: (workspaceId: string, slug: string, tipFrontiersBase64: string) => Promise<void>
  // Notify all peers on the same key when a HEAD switch completes.
  // This is only a UI signal because checkoutTo already broadcasts the Loro update.
  notifyHeadChanged?: (workspaceId: string, slug: string, head: string) => void
  // Merge source into target.
  // dryRun=true returns preview + badges without persisting changes.
  // dryRun=false updates target tipFrontiers and, if target is HEAD, reconciles and broadcasts the live doc.
  // Deployments without this hook return 501 unsupported_merge.
  performMerge?: (
    workspaceId: string,
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
    workspaceId: string,
    slug: string,
    oldName: string,
    newName: string,
  ) => Promise<number>
  // Count function used by DELETE /branches/:name to return actual unmergedCommits.
  // If omitted, the route falls back to 0.
  countVersionsOnBranch?: (workspaceId: string, slug: string, branchName: string) => Promise<number>
}

// Helper that turns ValidationError into a structured 400 response.
// Re-throw everything else so the caller can handle it as a 500.
function handleValidation(
  err: unknown,
): { status: 400; body: { error: string; message: string } } | null {
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

  // ── GET /api/workspaces/:sid/canvases/:slug/branches ──
  app.get('/api/workspaces/:sid/canvases/:slug/branches', async (c) => {
    const { sid, slug } = c.req.param()
    try {
      validateWorkspaceId(sid)
      validateSlug(slug)
    } catch (err) {
      const v = handleValidation(err)
      if (v) return c.json(v.body, v.status)
      throw err
    }
    try {
      const state: CanvasBranchesState = await loadCanvasBranches(sid, slug)
      return c.json(state)
    } catch (err) {
      const corruption = handleCorruption(err)
      if (corruption) return c.json(corruption.body, corruption.status)
      throw err
    }
  })

  // ── POST /api/workspaces/:sid/canvases/:slug/branches ──
  app.post('/api/workspaces/:sid/canvases/:slug/branches', async (c) => {
    const { sid, slug } = c.req.param()
    try {
      validateWorkspaceId(sid)
      validateSlug(slug)
    } catch (err) {
      const v = handleValidation(err)
      if (v) return c.json(v.body, v.status)
      throw err
    }
    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_body', message: 'malformed JSON' }, 400)
    }
    const parsed = createBranchRequestSchema.safeParse(rawBody)
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', message: 'name is required' }, 400)
    }
    const reqBody = parsed.data
    const nameValidation = validateBranchNameOrRespond(reqBody.name)
    if (nameValidation) return c.json(nameValidation.body, nameValidation.status)

    let initialTipFrontiers: string | undefined
    let baseVersionId: string | undefined
    if (reqBody.fromVersionId !== undefined) {
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
        validateVersionId(reqBody.fromVersionId)
      } catch (err) {
        const v = handleValidation(err)
        if (v) return c.json(v.body, v.status)
        throw err
      }
      const resolved = await resolveFromVersionFrontiers(sid, reqBody.fromVersionId)
      if (resolved === null) {
        return c.json(branchNotFound(`Version "${reqBody.fromVersionId}" not found`), 404)
      }
      initialTipFrontiers = resolved
      baseVersionId = reqBody.fromVersionId
    }

    try {
      const branch = await createBranch(sid, slug, {
        name: reqBody.name,
        ...(initialTipFrontiers !== undefined ? { initialTipFrontiers } : {}),
        ...(baseVersionId !== undefined ? { baseVersionId } : {}),
        ...(reqBody.color !== undefined ? { color: reqBody.color } : {}),
      })
      const response: CreateBranchResponse = { branch }
      return c.json(response, 201)
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

  // ── DELETE /api/workspaces/:sid/canvases/:slug/branches/:name ──
  app.delete('/api/workspaces/:sid/canvases/:slug/branches/:name', async (c) => {
    const { sid, slug, name } = c.req.param()
    try {
      validateWorkspaceId(sid)
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
      const response: DeleteBranchResponse = { ...result, unmergedCommits: unmerged }
      return c.json(response)
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

  // ── PUT /api/workspaces/:sid/canvases/:slug/head ──
  // Update branches.json on HEAD switch.
  // When getCurrentFrontiers / checkoutTo are provided, also:
  //   1) save the current doc.frontiers() onto the previous HEAD
  //   2) reconcile + broadcast when the new HEAD tipFrontiers is non-empty
  app.put('/api/workspaces/:sid/canvases/:slug/head', async (c) => {
    const { sid, slug } = c.req.param()
    try {
      validateWorkspaceId(sid)
      validateSlug(slug)
    } catch (err) {
      const v = handleValidation(err)
      if (v) return c.json(v.body, v.status)
      throw err
    }
    const parsed = setHeadRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', message: 'branch is required' }, 400)
    }
    const targetBranch = parsed.data.branch
    const bn = validateBranchNameOrRespond(targetBranch)
    if (bn) return c.json(bn.body, bn.status)
    try {
      // The entire read-modify-write — including the awaited
      // getCurrentFrontiers/checkoutTo calls in between — runs inside the
      // single workspace write lock acquisition that withCanvasBranchesLock
      // provides. Without that, file-gc's collect-then-unlink pass could
      // interleave right after checkoutTo moves the live doc onto the new
      // HEAD but before the outgoing HEAD's captured frontiers land in
      // branches.json, and would see a file as unreferenced by either.
      const response = await withCanvasBranchesLock(sid, slug, async (before, save) => {
        if (!before.branches.some((b) => b.name === targetBranch)) {
          throw new BranchNotFoundError(`Branch "${targetBranch}" not found on ${sid}/${slug}`)
        }
        if (before.head === targetBranch) {
          const same: SetHeadResponse = { head: targetBranch, previousHead: before.head }
          return same
        }

        // First ensure current-frontiers read and target checkout succeed.
        // Only then write branches.json once, avoiding partial writes on corruption.
        let currentFrontiers: string | null = null
        if (getCurrentFrontiers) {
          currentFrontiers = await getCurrentFrontiers(sid, slug)
        }

        // Reconcile to the new HEAD tipFrontiers only when non-empty.
        // checkoutTo handles strict prevalidation.
        const newTip = before.branches.find((b) => b.name === targetBranch)?.tipFrontiers ?? ''
        if (checkoutTo) {
          if (newTip.length > 0) {
            await checkoutTo(sid, slug, newTip)
          }
        }

        const next = {
          head: targetBranch,
          branches: before.branches.map((branch) => {
            if (branch.name !== before.head || currentFrontiers === null) return branch
            return { ...branch, tipFrontiers: currentFrontiers }
          }),
        }
        await save(next)
        const result: SetHeadResponse = { head: targetBranch, previousHead: before.head }
        return result
      })

      // Notify all peers on the same key that HEAD changed. Skip the
      // no-op case (switching to the branch that is already HEAD) so
      // idempotent re-switches don't fire a spurious signal.
      if (notifyHeadChanged && response.previousHead !== targetBranch) {
        notifyHeadChanged(sid, slug, targetBranch)
      }

      return c.json(response)
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

  // ── POST /api/workspaces/:sid/canvases/:slug/branches/:source/merge ──
  // Spec §7. Merge source (URL param) into target (body). dryRun can return a preview without committing.
  // LWW edge-case detection lives in merge-engine.detectMergeBadges; document operations are delegated to performMerge.
  app.post('/api/workspaces/:sid/canvases/:slug/branches/:source/merge', async (c) => {
    const { sid, slug, source } = c.req.param()
    try {
      validateWorkspaceId(sid)
      validateSlug(slug)
    } catch (err) {
      const v = handleValidation(err)
      if (v) return c.json(v.body, v.status)
      throw err
    }
    const srcValidation = validateBranchNameOrRespond(source)
    if (srcValidation) return c.json(srcValidation.body, srcValidation.status)

    const parsed = mergeRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', message: 'into is required' }, 400)
    }
    const reqBody = parsed.data
    const intoValidation = validateBranchNameOrRespond(reqBody.into)
    if (intoValidation) return c.json(intoValidation.body, intoValidation.status)

    if (source === reqBody.into) {
      return c.json({ error: 'invalid_body', message: 'source and into must differ' }, 400)
    }

    if (!performMerge) {
      return c.json(
        { error: 'unsupported_merge', message: 'merge is not supported in this deployment' },
        501,
      )
    }

    const dryRun = reqBody.dryRun === true
    try {
      const result = await performMerge(sid, slug, { source, into: reqBody.into, dryRun })
      const response: MergeResponse = { badges: result.badges }
      if (result.committed) {
        response.committed = { elementCount: result.previewElementCount }
      } else {
        response.preview = { elementCount: result.previewElementCount }
      }
      // Optional target/source counts for the three-column UI.
      if (typeof result.targetElementCount === 'number') {
        response.target = { elementCount: result.targetElementCount }
      }
      if (typeof result.sourceElementCount === 'number') {
        response.source = { elementCount: result.sourceElementCount }
      }
      // For dry runs, return the preview scene so MergeDialog can render Excalidraw.
      // After commit, the updated HEAD already drives the canvas state.
      if (!result.committed && Array.isArray(result.previewElements)) {
        response.previewElements = result.previewElements
      }
      // Include commit metadata used by UI highlighting and undo.
      if (result.committed) {
        if (Array.isArray(result.newElementIds)) response.newElementIds = result.newElementIds
        if (Array.isArray(result.changedElementIds))
          response.changedElementIds = result.changedElementIds
        if (Array.isArray(result.conflictElementIds))
          response.conflictElementIds = result.conflictElementIds
        if (typeof result.preMergeVersionId === 'string')
          response.preMergeVersionId = result.preMergeVersionId
        if (result.switchedHead) response.switchedHead = result.switchedHead
        if (typeof result.deletedSource === 'string') response.deletedSource = result.deletedSource
      }
      return c.json(response)
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

  // ── GET /api/workspaces/:sid/canvases/:slug/branches/:name/stats ──
  // Pre-check endpoint for the delete confirmation dialog.
  // Returns actual unmergedCommits plus isHead.
  app.get('/api/workspaces/:sid/canvases/:slug/branches/:name/stats', async (c) => {
    const { sid, slug, name } = c.req.param()
    try {
      validateWorkspaceId(sid)
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
      const response: BranchStatsResponse = { unmergedCommits, isHead }
      return c.json(response)
    } catch (err) {
      const corrupt = handleCorruption(err)
      if (corrupt) return c.json(corrupt.body, corrupt.status)
      throw err
    }
  })

  // ── PATCH /api/workspaces/:sid/canvases/:slug/branches/:name ──
  // Rename with body { name: newName }. main returns 409, conflicts return 409, missing returns 404.
  // version-store branchName updates are delegated to renameInVersions and default to 0 when omitted.
  app.patch('/api/workspaces/:sid/canvases/:slug/branches/:name', async (c) => {
    const { sid, slug, name } = c.req.param()
    try {
      validateWorkspaceId(sid)
      validateSlug(slug)
    } catch (err) {
      const v = handleValidation(err)
      if (v) return c.json(v.body, v.status)
      throw err
    }
    const oldValidation = validateBranchNameOrRespond(name)
    if (oldValidation) return c.json(oldValidation.body, oldValidation.status)

    let rawRenameBody: unknown
    try {
      rawRenameBody = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_body', message: 'malformed JSON' }, 400)
    }
    const parsed = renameBranchRequestSchema.safeParse(rawRenameBody)
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', message: 'name is required' }, 400)
    }
    const newName = parsed.data.name
    const newValidation = validateBranchNameOrRespond(newName)
    if (newValidation) return c.json(newValidation.body, newValidation.status)

    try {
      const branch = await renameBranch(sid, slug, name, newName)
      let renamedVersionCount = 0
      if (renameInVersions) {
        try {
          renamedVersionCount = await renameInVersions(sid, slug, name, newName)
        } catch (err) {
          try {
            await renameBranch(sid, slug, newName, name)
          } catch {
            /* rollback best-effort; original error is returned */
          }
          throw err
        }
      }
      const response: RenameBranchResponse = { branch, renamedVersionCount }
      return c.json(response)
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
