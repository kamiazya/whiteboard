import {
  type ListVersionsResponse,
  type SaveVersionResponse,
  saveVersionRequestSchema,
  type VersionDocumentResponse,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import {
  readDocumentKind,
  readMarkdownBody,
  readSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { RequestOperator } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { getDoc } from '../../store/document-store.js'
import type { OperatorInfo, VersionStore } from '../../store/version-store.js'
import {
  defaultHumanDisplayName,
  handleCorruptStoredData,
  handleDocumentNotFound,
} from './_shared.js'
import { onDocumentsRoute } from './path-route.js'

export interface VersionsRouterOptions {
  versionStore: VersionStore
  /**
   * This daemon as an OKF actor — its `did:key` (ADR-0035 decision 2).
   * Optional so a composition without an identity records no actor rather
   * than an invented one; `app.ts` always passes it.
   */
  daemonActor?: string
}

// GET /api/workspaces/:workspaceId/documents/:path/versions
// POST /api/workspaces/:workspaceId/documents/:path/versions
export function createVersionsRouter(options: VersionsRouterOptions) {
  const app = new Hono()
  const { versionStore, daemonActor } = options

  // List versions for one canvas in reverse chronological order.
  onDocumentsRoute(app, 'get', ['versions'], async (c, workspaceId, path) => {
    try {
      const versions = await versionStore.list(workspaceId, path)
      const response: ListVersionsResponse = { versions }
      return c.json(response)
    } catch (err) {
      const missing = handleDocumentNotFound(err)
      if (missing) return c.json(missing.body, missing.status)
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  /**
   * One version's CONTENT, for previewing it before deciding to restore.
   *
   * The panel used to offer restore behind a confirmation dialog and nothing
   * else, so the only way to find out what a version held was to apply it and
   * look. This is the read that makes "see it, then decide" possible.
   *
   * Projected here rather than shipped as CRDT bytes: what a viewer needs is
   * something to draw, and the two shapes below are what every surface that
   * draws a document already speaks.
   */
  onDocumentsRoute(
    app,
    'get',
    ['versions', ':id', 'document'],
    async (c, workspaceId, path, params) => {
      const id = params.id as string
      try {
        // The version must belong to THIS document. Without the check an id
        // alone would read another document's history through this path — the
        // refusal `restoreVersion` makes for the same reason.
        const owned = (await versionStore.list(workspaceId, path)).some((v) => v.id === id)
        if (!owned) return c.json({ error: 'version not found' }, 404)

        // Already the past DOCUMENT: `load` checks the frontier out against
        // the stored workspace and projects it, which is the shape restore
        // reconciles from too.
        const past = await versionStore.load(workspaceId, id)
        if (past === null) return c.json({ error: 'version not found' }, 404)

        const response: VersionDocumentResponse =
          readDocumentKind(past) === 'markdown'
            ? { kind: 'markdown', body: readMarkdownBody(past) }
            : { kind: 'spatial', canvas: readSpatialCanvas(past) }
        return c.json(response)
      } catch (err) {
        const missing = handleDocumentNotFound(err)
        if (missing) return c.json(missing.body, missing.status)
        const issue = handleCorruptStoredData(err)
        if (issue) return c.json(issue.body, issue.status)
        throw err
      }
    },
  )

  // Save a manual version with body { label?: string; operator?: RequestOperator }.
  // auto is false.
  onDocumentsRoute(app, 'post', ['versions'], async (c, workspaceId, path) => {
    // Empty body is valid (no label / operator); a non-empty body must parse as
    // JSON and pass schema validation, otherwise return invalid_body.
    const rawText = await c.req.text()
    let label: string | undefined
    let operator: RequestOperator | undefined
    if (rawText.length > 0) {
      let json: unknown
      try {
        json = JSON.parse(rawText)
      } catch {
        return c.json({ error: 'invalid_body', message: 'malformed JSON' }, 400)
      }
      const parsed = saveVersionRequestSchema.safeParse(json)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        // The actor case gets its own sentence: a caller sending one has a
        // wrong model of whose name it is, and "operator is invalid" would
        // send them looking at the wrong field.
        const namedTheDevice = issue?.code === 'unrecognized_keys' && issue.keys.includes('actor')
        const message = namedTheDevice
          ? 'operator.actor is stamped by the daemon and must not be sent'
          : issue?.path[0] === 'operator'
            ? 'operator is invalid'
            : 'label must be string'
        return c.json({ error: 'invalid_body', message }, 400)
      }
      label = parsed.data.label
      operator = parsed.data.operator
    }
    try {
      const doc = await getDoc(workspaceId, path)
      // The SCHEMA is what stops a caller naming the device; this spread
      // order is arrangement, not a second guard — measured, reversing it
      // fails no test, because nothing can get an `actor` past the schema to
      // notice. A caller that names no operator at all still gets one.
      const nextOperator: OperatorInfo = {
        ...(operator ?? { kind: 'human' as const, displayName: defaultHumanDisplayName() }),
        ...(daemonActor === undefined ? {} : { actor: daemonActor }),
      }
      const entry = await versionStore.save(workspaceId, path, doc, {
        auto: false,
        ...(label !== undefined ? { label } : {}),
        operator: nextOperator,
      })
      const response: SaveVersionResponse = { version: entry }
      return c.json(response)
    } catch (err) {
      const missing = handleDocumentNotFound(err)
      if (missing) return c.json(missing.body, missing.status)
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  return app
}
