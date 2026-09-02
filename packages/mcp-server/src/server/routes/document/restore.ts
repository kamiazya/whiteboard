import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import {
  NoSuchVersionError,
  NotWorkspaceScopedError,
  RestoreTargetNotFoundError,
  restoreVersion,
  SubtreeTargetError,
  TargetExistsError,
} from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { getDefaultServerDeps } from '../../../di/default-server-deps.js'
import { restoreVersionRequestSchema } from '../../../shared/api-contracts/document.js'
import { validateDocumentPath, validateVersionId, validationErrorBody } from '../../validators.js'
import { handleCorruptStoredData } from './_shared.js'
import { onDocumentsRoute } from './path-route.js'

export interface RestoreRouterOptions {
  // The operation this route adapts onto (ADR-0018). Production wires it
  // from app.ts; a caller that omits it gets `getDefaultServerDeps`, which
  // is the same wiring over the same memoized connection, not a stand-in.
  serverDeps?: ServerDeps
}

// POST /api/workspaces/:workspaceId/documents/:path/versions/:id/restore
//
// A translator, nothing more: it parses the request, calls the operation,
// and maps the result and its refusals onto a response. Every decision
// about what a restore MEANS — the three modes, why an existing target is
// reconciled rather than swapped, why deletions run first in a subtree
// rollback — lives in `restoreVersion` so a second surface gets the same
// answer.
//
// Two modes share the endpoint, selected by the optional JSON body:
//
//   1. In-place reconcile (default; the History panel uses this). CRDTs
//      cannot forget history, so the operation commits new ops whose
//      result equals the past state.
//   2. Restore into `targetPath` — body `{ targetPath, overwrite? }`. A new
//      target is created; an existing one needs `overwrite: true` and is
//      reconciled exactly as mode 1 is, onto the target's own live doc.
//      `targetPath === path` collapses into mode 1. Without `overwrite`,
//      an existing target answers 409 `output_exists`.
//
// `{ subtree: true }` rolls the document and every descendant back, and
// needs a workspace-scoped version to do it.
export function createRestoreRouter(options: RestoreRouterOptions = {}) {
  const app = new Hono()

  onDocumentsRoute(
    app,
    'post',
    ['versions', ':id', 'restore'],
    async (c, workspaceId, path, params) => {
      const versionId = params.id as string
      try {
        validateVersionId(versionId)
      } catch (err) {
        const body = validationErrorBody(err)
        if (body) return c.json(body, 400)
        throw err
      }
      // Body is optional. Empty body / non-JSON => in-place mode.
      const rawText = await c.req.text()
      let targetPath: string | undefined
      let overwrite = false
      let subtree = false
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
        targetPath = parsed.data.targetPath
        overwrite = parsed.data.overwrite === true
        subtree = parsed.data.subtree === true
      }
      if (targetPath !== undefined) {
        try {
          validateDocumentPath(targetPath)
        } catch (err) {
          const body = validationErrorBody(err)
          if (body) return c.json(body, 400)
          throw err
        }
      }

      const deps = options.serverDeps ?? (await getDefaultServerDeps())
      // The version id belongs to the SOURCE document's history, so its
      // label lives in the source's list whatever document the restore
      // lands on. The overlay a client shows is addressed to the document
      // being written, which is the target when one is named.
      const eventPath = targetPath !== undefined && !subtree ? targetPath : path
      const { sendRestoreEvent } = await import('../ws.js')

      try {
        const label = (await deps.versions.list(workspaceId, path)).find(
          (v) => v.id === versionId,
        )?.label
        sendRestoreEvent(workspaceId, eventPath, 'started', label)
        try {
          const result = await restoreVersion(deps, {
            workspaceId,
            path,
            versionId,
            ...(targetPath !== undefined ? { targetPath } : {}),
            ...(overwrite ? { overwrite } : {}),
            ...(subtree ? { subtree } : {}),
          })
          switch (result.kind) {
            case 'in-place':
              return c.json({ ok: true })
            case 'into-target':
              return c.json({
                documentId: `${workspaceId}/${targetPath}`,
                elementCount: result.elementCount,
              })
            case 'subtree':
              return c.json({ ok: true, restoredCount: result.restoredCount })
          }
        } finally {
          // Always, even on error, or the client overlay stays locked.
          sendRestoreEvent(workspaceId, eventPath, 'complete')
        }
      } catch (err) {
        if (err instanceof NoSuchVersionError || err instanceof RestoreTargetNotFoundError) {
          return c.json({ error: 'not_found' }, 404)
        }
        if (err instanceof TargetExistsError) {
          return c.json(
            {
              error: 'output_exists',
              message: `Target canvas "${err.targetPath}" already exists. Pass overwrite=true to replace it.`,
            },
            409,
          )
        }
        if (err instanceof NotWorkspaceScopedError) {
          return c.json(
            { error: 'unsupported', message: 'subtree rollback needs a workspace-scoped version' },
            409,
          )
        }
        if (err instanceof SubtreeTargetError) {
          return c.json({ error: 'invalid_body', message: err.message }, 400)
        }
        const issue = handleCorruptStoredData(err)
        if (issue) return c.json(issue.body, issue.status)
        throw err
      }
    },
  )

  return app
}
