import {
  type RestoreVersionResponse,
  restoreVersionRequestSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import {
  type ApiErrorBody,
  errorBody,
  type RestoreProgress,
  restoreVersion,
  type ServerDeps,
  syncWriteAnswer,
  type VersionHistory,
} from '@kamiazya/whiteboard-server-core'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { type AuthScope, hasRequiredScopes } from '../../security/auth-strategy.js'
import { restoreScopes } from '../../security/route-scope-registry.js'
import { validateDocumentPath, validateVersionId } from '../../validators.js'
import { readJsonBody } from '../read-json-body.js'
import {
  type ErrorAnswer,
  handleCorruptStoredData,
  invalidBodyRefusal,
  pastWorkspaceCeiling,
  refusedBy,
} from './_shared.js'
import { onDocumentsRoute } from './path-route.js'

export interface RestoreRouterOptions {
  versionStore: VersionHistory
  // The operation's live-document seam, handed down from document.ts.
  serverDeps: ServerDeps
  // How a restore announces itself to connected clients. Absent means nobody
  // is told, which is the right answer for a router with no live audience.
  progress?: RestoreProgress
  /**
   * The scopes of the grant the auth middleware resolved for this request.
   * Absent for a router mounted without that middleware, which gates
   * nothing; answering undefined refuses the restore.
   */
  callerScopes?: CallerScopes
}

/** The scopes the request's grant holds, where an auth middleware resolved one. */
export type CallerScopes = (c: Context) => readonly AuthScope[] | undefined

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
type RestoreAnswer =
  | { status: 200; body: RestoreVersionResponse }
  | { status: 400 | 404 | 409; body: ApiErrorBody }

/** A restore that happened answers under the one contract the client reads it with. */
const restored = (body: RestoreVersionResponse): RestoreAnswer => ({ status: 200, body })
const refused = (body: ApiErrorBody, status: 400 | 404 | 409): RestoreAnswer => ({ status, body })

/**
 * The operation's schema backstop rejected the target; re-run the rich
 * per-segment validator for the same 400 body this route has always sent.
 */
function invalidTargetAnswer(targetPath: string | undefined): RestoreAnswer {
  const invalidTarget = refusedBy(() => validateDocumentPath(targetPath ?? ''))
  if (invalidTarget) return refused(invalidTarget, 400)
  return refused({ error: 'invalid_body', message: 'invalid restore options' }, 400)
}

function restoreAnswer(
  result: Awaited<ReturnType<typeof restoreVersion>>,
  { targetPath }: { targetPath: string | undefined },
): RestoreAnswer {
  switch (result.kind) {
    case 'not-found':
      return refused(errorBody('not_found', 'That version does not exist for this document.'), 404)
    case 'invalid-target-path':
      return invalidTargetAnswer(targetPath)
    case 'subtree-takes-no-target':
      return refused(
        { error: 'invalid_body', message: 'subtree rollback cannot take a targetPath' },
        400,
      )
    case 'subtree-needs-workspace-version':
      return refused(
        {
          error: 'unsupported',
          message: 'subtree rollback needs a workspace-scoped version',
        },
        409,
      )
    case 'output-exists':
      return refused(
        {
          error: 'output_exists',
          message: `Target document "${result.targetPath}" already exists. Pass overwrite=true to replace it.`,
        },
        409,
      )
    case 'kind-mismatch':
      return refused(
        {
          error: 'document_kind_mismatch',
          message: `Target document "${result.targetPath}" is a ${result.targetKind} document and this version is ${result.sourceKind}; a document's kind is written once, so restore into a new path instead.`,
        },
        409,
      )
    case 'restored-to-target':
      return restored({
        documentId: result.documentId,
        elementCount: result.elementCount,
      })
    case 'restored-subtree':
      return restored({ ok: true, restoredCount: result.restoredCount })
    case 'restored-in-place':
      return restored({ ok: true })
  }
}

/**
 * The registry scoped this route by its path, before the body said which
 * restore it is; one that writes other documents needs more (`restoreScopes`).
 *
 * `callerScopes` absent is a router mounted with no auth middleware, which
 * gates nothing. Wired but answering undefined is a request that skipped the
 * middleware that always records a grant, so it holds no scopes at all.
 */
function scopeRefusal(
  callerScopes: CallerScopes | undefined,
  c: Context,
  asked: { readonly targetPath?: string; readonly subtree?: boolean },
  path: string,
): ApiErrorBody | null {
  if (callerScopes === undefined) return null
  const granted = callerScopes(c)
  if (granted !== undefined && hasRequiredScopes(granted, restoreScopes(asked, path))) return null
  return errorBody(
    'insufficient_scope',
    "This credential's scopes do not reach a restore into another document or a subtree.",
  )
}

/** A saved state past a sync limit, refused in the code and status a sync write gets. */
const pastSyncLimit: ErrorAnswer = (err) => {
  const refusal = syncWriteAnswer(err)
  return refusal === undefined
    ? null
    : { status: refusal.status, body: errorBody(refusal.code, (err as Error).message) }
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
      // The body is optional and its absence means in-place: an empty request
      // is the commonest restore there is, so it must not be a refusal.
      const asked = await readJsonBody(c, restoreVersionRequestSchema, {
        voice: 'code',
        optional: true,
        refuseShape: (error) => invalidBodyRefusal(error, 'invalid restore options'),
      })
      if ('refusal' in asked) return asked.refusal
      const outOfScope = scopeRefusal(options.callerScopes, c, asked.data, path)
      if (outOfScope) return c.json(outOfScope, 403)
      const { targetPath, overwrite, subtree } = asked.data
      try {
        const result = await restoreVersion(
          { versions: versionStore, liveDocuments: options.serverDeps.liveDocuments },
          {
            workspaceId,
            path,
            versionId: id,
            ...(targetPath === undefined ? {} : { targetPath }),
            overwrite: overwrite === true,
            subtree: subtree === true,
          },
          options.progress,
        )
        const answer = restoreAnswer(result, { targetPath })
        return c.json(answer.body, answer.status)
      } catch (err) {
        const issue =
          handleCorruptStoredData(err) ?? pastWorkspaceCeiling(err) ?? pastSyncLimit(err)
        if (issue) return c.json(issue.body, issue.status)
        throw err
      }
    },
  )

  return app
}
