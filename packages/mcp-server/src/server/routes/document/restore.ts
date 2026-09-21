import { restoreVersionRequestSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import {
  type RestoreProgress,
  restoreVersion,
  type ServerDeps,
  type VersionHistory,
} from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { getDefaultServerDeps } from '../../../di/default-server-deps.js'
import { validateDocumentPath, validateVersionId } from '../../validators.js'
import { handleCorruptStoredData, refusedBy } from './_shared.js'
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
/**
 * What each restore OUTCOME answers with.
 *
 * A dispatch rather than a step, and it belongs outside the handler for
 * that reason: the handler's job is to refuse a bad request and run the
 * operation, and which of eight outcomes came back is the operation's
 * vocabulary, not the route's control flow.
 */
function restoreAnswer(
  result: Awaited<ReturnType<typeof restoreVersion>>,
  { workspaceId, targetPath }: { workspaceId: string; targetPath: string | undefined },
): { status: 200 | 400 | 404 | 409; body: unknown } {
  const answer = (b: unknown, status: 200 | 400 | 404 | 409 = 200) => ({ status, body: b })
  switch (result.kind) {
    case 'not-found':
      return answer({ error: 'not_found' }, 404)
    case 'invalid-target-path':
      // The operation's schema backstop rejected it; re-run the rich
      // per-segment validator for the same 400 body this route has
      // always sent.
      {
        const invalidTarget = refusedBy(() => validateDocumentPath(targetPath ?? ''))
        if (invalidTarget) return answer(invalidTarget, 400)
      }
      return answer({ error: 'invalid_body', message: 'invalid restore options' }, 400)
    case 'subtree-takes-no-target':
      return answer(
        { error: 'invalid_body', message: 'subtree rollback cannot take a targetPath' },
        400,
      )
    case 'subtree-needs-workspace-version':
      return answer(
        {
          error: 'unsupported',
          message: 'subtree rollback needs a workspace-scoped version',
        },
        409,
      )
    case 'output-exists':
      return answer(
        {
          error: 'output_exists',
          message: `Target canvas "${result.targetPath}" already exists. Pass overwrite=true to replace it.`,
        },
        409,
      )
    case 'restored-to-target':
      return answer({
        documentId: `${workspaceId}/${result.targetPath}`,
        elementCount: result.elementCount,
      })
    case 'restored-subtree':
      return answer({ ok: true, restoredCount: result.restoredCount })
    case 'restored-in-place':
      return answer({ ok: true })
  }
}

/**
 * What a restore was ASKED for, read off an optional body.
 *
 * The body is optional and its absence means in-place: an empty request is
 * the commonest restore there is, so it must not be a refusal. A body that
 * is present and unreadable IS one, and the two unreadable kinds stay
 * distinct — malformed JSON and well-formed JSON of the wrong shape are
 * different mistakes to make.
 */
function restoreOptionsFrom(
  rawText: string,
):
  | { targetPath: string | undefined; overwrite: boolean; subtree: boolean }
  | { refusal: { error: 'invalid_body'; message: string } } {
  if (rawText.length === 0) return { targetPath: undefined, overwrite: false, subtree: false }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawText)
  } catch {
    return { refusal: { error: 'invalid_body', message: 'malformed JSON' } }
  }
  const parsed = restoreVersionRequestSchema.safeParse(parsedJson)
  if (!parsed.success) {
    return { refusal: { error: 'invalid_body', message: 'invalid restore options' } }
  }
  return {
    targetPath: parsed.data.targetPath,
    overwrite: parsed.data.overwrite === true,
    subtree: parsed.data.subtree === true,
  }
}

export function createRestoreRouter(options: RestoreRouterOptions) {
  const app = new Hono()
  const { versionStore } = options

  onDocumentsRoute(
    app,
    'post',
    ['versions', ':id', 'restore'],
    async (c, workspaceId, path, params) => {
      const id = params.id as string
      const invalidVersionId = refusedBy(() => validateVersionId(id))
      if (invalidVersionId) return c.json(invalidVersionId, 400)
      const asked = restoreOptionsFrom(await c.req.text())
      if ('refusal' in asked) return c.json(asked.refusal, 400)
      const { targetPath, overwrite, subtree } = asked
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
        const answer = restoreAnswer(result, { workspaceId, targetPath })
        return c.json(answer.body, answer.status)
      } catch (err) {
        const issue = handleCorruptStoredData(err)
        if (issue) return c.json(issue.body, issue.status)
        throw err
      }
    },
  )

  return app
}
