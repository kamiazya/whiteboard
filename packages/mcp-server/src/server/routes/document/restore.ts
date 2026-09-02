import {
  type RestoreProgress,
  restoreVersion,
  type ServerDeps,
  type VersionHistory,
} from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { getDefaultServerDeps } from '../../../di/default-server-deps.js'
import { restoreVersionRequestSchema } from '../../../shared/api-contracts/document.js'
import { validateDocumentPath, validateVersionId, validationErrorBody } from '../../validators.js'
import { handleCorruptStoredData } from './_shared.js'
import { onDocumentsRoute } from './path-route.js'

export interface RestoreRouterOptions {
  versionStore: VersionHistory
  // The operation's live-document seam. Production wires this from
  // document.ts; a router built without it falls back to the same wiring via
  // getDefaultServerDeps (see that file for why the fallback is real, not a
  // stand-in).
  serverDeps?: ServerDeps
  // How a restore announces itself to connected clients. Absent means nobody
  // is told, which is the right answer for a router with no WS surface.
  progress?: RestoreProgress
}

// POST /api/workspaces/:workspaceId/documents/:path/versions/:id/restore
//
// A TRANSLATION-ONLY adapter (ADR-0018): parse and validate the request,
// call server-core's restoreVersion operation, and map its result union onto
// this route's status codes and bodies. The three restore modes, the lock
// bracket, kind propagation and evict-on-failure all live in the operation —
// see its doc comment.
export function createRestoreRouter(options: RestoreRouterOptions) {
  const app = new Hono()
  const { versionStore } = options

  onDocumentsRoute(
    app,
    'post',
    ['versions', ':id', 'restore'],
    async (c, workspaceId, path, params) => {
      const id = params.id as string
      try {
        validateVersionId(id)
      } catch (err) {
        const body = validationErrorBody(err)
        if (body) return c.json(body, 400)
        throw err
      }
      // Body is optional. Empty body / non-JSON ⇒ in-place mode.
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
      try {
        const deps = options.serverDeps ?? (await getDefaultServerDeps())
        const result = await restoreVersion(
          { versions: versionStore, liveDocuments: deps.liveDocuments },
          {
            workspaceId,
            path,
            versionId: id,
            ...(targetPath === undefined ? {} : { targetPath }),
            overwrite,
            subtree,
          },
          options.progress,
        )
        switch (result.kind) {
          case 'not-found':
            return c.json({ error: 'not_found' }, 404)
          case 'invalid-target-path':
            // The operation's schema backstop rejected it; re-run the rich
            // per-segment validator for the same 400 body this route has
            // always sent.
            try {
              validateDocumentPath(targetPath ?? '')
            } catch (err) {
              const body = validationErrorBody(err)
              if (body) return c.json(body, 400)
              throw err
            }
            return c.json({ error: 'invalid_body', message: 'invalid restore options' }, 400)
          case 'subtree-takes-no-target':
            return c.json(
              { error: 'invalid_body', message: 'subtree rollback cannot take a targetPath' },
              400,
            )
          case 'subtree-needs-workspace-version':
            return c.json(
              {
                error: 'unsupported',
                message: 'subtree rollback needs a workspace-scoped version',
              },
              409,
            )
          case 'output-exists':
            return c.json(
              {
                error: 'output_exists',
                message: `Target canvas "${result.targetPath}" already exists. Pass overwrite=true to replace it.`,
              },
              409,
            )
          case 'restored-to-target':
            return c.json({
              documentId: `${workspaceId}/${result.targetPath}`,
              elementCount: result.elementCount,
            })
          case 'restored-subtree':
            return c.json({ ok: true, restoredCount: result.restoredCount })
          case 'restored-in-place':
            return c.json({ ok: true })
        }
      } catch (err) {
        const issue = handleCorruptStoredData(err)
        if (issue) return c.json(issue.body, issue.status)
        throw err
      }
    },
  )

  return app
}
