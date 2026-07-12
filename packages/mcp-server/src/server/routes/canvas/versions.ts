import { Hono } from 'hono'
import {
  type ListVersionsResponse,
  type SaveVersionResponse,
  saveVersionRequestSchema,
} from '../../../shared/api-contracts/canvas.js'
import { isCorruptStoredDataError } from '../../store/corrupt-stored-data.js'
import { getDoc } from '../../store/doc-cache.js'
import type { OperatorInfo, VersionStore } from '../../store/version-store.js'
import { validateSlug, validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { defaultHumanDisplayName, handleCorruptStoredData } from './shared.js'

export interface VersionsRouterOptions {
  versionStore: VersionStore
  getHeadBranch?: (workspaceId: string, slug: string) => Promise<string | null>
}

// GET /api/workspaces/:workspaceId/canvases/:slug/versions
// POST /api/workspaces/:workspaceId/canvases/:slug/versions
export function createVersionsRouter(options: VersionsRouterOptions) {
  const app = new Hono()
  const { versionStore } = options

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

  return app
}
