import {
  DocumentPathTakenError,
  WorkspaceNotFoundError as PortWorkspaceNotFoundError,
} from '@kamiazya/whiteboard-ports'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { ContentFactsCache } from './references/content-facts-cache.js'
import type { ServerDeps } from './server-deps.js'
import { backlinksInputSchema, computeBacklinks } from './tools/backlinks.js'
import { createBodyPatchTool } from './tools/body-patch.js'
import { createCanvasEditTool } from './tools/canvas-edit.js'
import { createCanvasRenderSvgTool } from './tools/canvas-render-svg.js'
import { createCanvasSnapshotTool } from './tools/canvas-snapshot.js'
import { createCanvasViewTool } from './tools/canvas-view.js'
import {
  WorkspaceDocumentNotFoundError,
  WorkspaceNotFoundError,
} from './tools/document-crud.errors.js'
import {
  wbDocumentCreate,
  wbDocumentDelete,
  wbDocumentList,
  wbDocumentResolve,
} from './tools/document-crud.js'
import {
  wbDocumentCreateInputSchema,
  wbDocumentDeleteInputSchema,
  wbDocumentListInputSchema,
  wbDocumentResolveInputSchema,
} from './tools/document-crud.schemas.js'
import { createDocumentGetTool } from './tools/document-get.js'
import { SnapshotNotFoundError } from './tools/document-io.js'
import { createDocumentSearchTool, documentSearchInputSchema } from './tools/document-search.js'
import { createDocumentSetTool } from './tools/document-set.js'
import { computeDocumentTags, documentTagsInputSchema } from './tools/document-tags.js'
import { exportOkf, exportOkfInputSchema } from './tools/export-okf.js'
import { createFacetListTool } from './tools/facet-list.js'
import { createFacetSetTool } from './tools/facet-set.js'
import {
  linkifyMentions,
  linkifyMentionsInputSchema,
  NamelessLinkifyTargetError,
} from './tools/linkify-mentions.js'
import { createVersionListTool } from './tools/version-list.js'
import { createVersionRestoreTool } from './tools/version-restore.js'
import { createVersionSaveTool } from './tools/version-save.js'
import { createViewportSetTool } from './tools/viewport-set.js'
import { resolveWorkspaceId, withResolvedWorkspaceHandles } from './workspace-handle.js'

export function createServer(deps: ServerDeps) {
  const app = new Hono<{ Variables: { workspaceId: string } }>()
  // One stamp-validated content-facts cache per server: backlinks/mentions,
  // tags, and search all read through it, so a request after a quiet period
  // reloads only what changed — regardless of which write path changed it.
  const factsCache = new ContentFactsCache()

  /**
   * The workspace handle is resolved HERE, once per request, and every handler
   * below reads the result rather than the raw path parameter.
   *
   * Middleware rather than a call in each handler: resolving twice in one
   * request is the failure this ordering exists to prevent — everything
   * downstream keys on the resolved id (write locks, document caches, sync
   * docKeys), and two independent resolutions can disagree the moment a
   * segment moves between workspaces mid-flight.
   */
  app.use('/api/v1/workspaces/:workspaceId/*', async (c, next) => {
    c.set('workspaceId', await resolveWorkspaceId(deps.documentIndex, c.req.param('workspaceId')))
    await next()
  })

  app.post('/api/v1/workspaces/:workspaceId/documents', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = wbDocumentCreateInputSchema.safeParse({
      workspaceId: c.get('workspaceId'),
      ...body,
    })
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    try {
      const result = await wbDocumentCreate(deps, parsed.data)
      return c.json(result, 201)
    } catch (err) {
      return mapDocumentError(c, err)
    }
  })

  app.get('/api/v1/workspaces/:workspaceId/documents', async (c) => {
    const parsed = wbDocumentListInputSchema.safeParse({ workspaceId: c.get('workspaceId') })
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    try {
      const result = await wbDocumentList(deps, parsed.data)
      return c.json(result, 200)
    } catch (err) {
      return mapDocumentError(c, err)
    }
  })

  app.get('/api/v1/workspaces/:workspaceId/documents/:documentId', async (c) => {
    const parsed = wbDocumentResolveInputSchema.safeParse({
      workspaceId: c.get('workspaceId'),
      documentId: c.req.param('documentId'),
    })
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    try {
      const result = await wbDocumentResolve(deps, parsed.data)
      return c.json(result, 200)
    } catch (err) {
      return mapDocumentError(c, err)
    }
  })

  app.delete('/api/v1/workspaces/:workspaceId/documents/:documentId', async (c) => {
    const parsed = wbDocumentDeleteInputSchema.safeParse({
      workspaceId: c.get('workspaceId'),
      documentId: c.req.param('documentId'),
    })
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    try {
      const result = await wbDocumentDelete(deps, parsed.data)
      return c.json(result, 200)
    } catch (err) {
      return mapDocumentError(c, err)
    }
  })

  // Read-only OKF projection of one document, over HTTP so a browsing UI
  // (workspace file tree) can open one without an MCP client. Deliberately
  // still OKF-specific: this is a different surface from the MCP tools, and
  // the tree wants markdown regardless of what wb_document_get would choose.
  app.get('/api/v1/workspaces/:workspaceId/search', async (c) => {
    const parsed = documentSearchInputSchema.safeParse({
      workspaceId: c.get('workspaceId'),
      query: c.req.query('q'),
      ...(c.req.query('kind') === undefined ? {} : { kind: c.req.query('kind') }),
      ...(c.req.queries('tag') === undefined || c.req.queries('tag')?.length === 0
        ? {}
        : { tags: c.req.queries('tag') }),
      ...(c.req.query('limit') === undefined ? {} : { limit: Number(c.req.query('limit')) }),
    })
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    try {
      return c.json(await tools.documentSearch.execute(parsed.data))
    } catch (err) {
      return mapDocumentError(c, err)
    }
  })

  app.get('/api/v1/workspaces/:workspaceId/document-tags', async (c) => {
    const parsed = documentTagsInputSchema.safeParse({ workspaceId: c.get('workspaceId') })
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    try {
      return c.json(await computeDocumentTags(deps, parsed.data, factsCache))
    } catch (err) {
      return mapDocumentError(c, err)
    }
  })

  app.post('/api/v1/workspaces/:workspaceId/documents/:documentId/linkify-mentions', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = linkifyMentionsInputSchema.safeParse({
      workspaceId: c.get('workspaceId'),
      documentId: c.req.param('documentId'),
      ...body,
    })
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    try {
      return c.json(await linkifyMentions(deps, parsed.data))
    } catch (err) {
      if (err instanceof NamelessLinkifyTargetError) {
        return c.json({ error: err.message }, 400)
      }
      return mapDocumentError(c, err)
    }
  })

  app.get('/api/v1/workspaces/:workspaceId/documents/:documentId/backlinks', async (c) => {
    const parsed = backlinksInputSchema.safeParse({
      workspaceId: c.get('workspaceId'),
      documentId: c.req.param('documentId'),
    })
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    try {
      return c.json(await computeBacklinks(deps, parsed.data, factsCache))
    } catch (err) {
      return mapDocumentError(c, err)
    }
  })

  app.get('/api/v1/workspaces/:workspaceId/documents/:documentId/okf', async (c) => {
    const parsed = exportOkfInputSchema.safeParse({
      workspaceId: c.get('workspaceId'),
      documentId: c.req.param('documentId'),
    })
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    try {
      const result = await exportOkf(deps, parsed.data)
      return c.json(result, 200)
    } catch (err) {
      // A tree node whose doc was never written (created but never
      // imported/edited) has no OKF projection — a read miss, not a 500.
      // `mapDocumentError` only knows document-crud's index-level errors, so
      // the store-level miss is answered here.
      if (err instanceof SnapshotNotFoundError) {
        return c.json({ error: err.message }, 404)
      }
      return mapDocumentError(c, err)
    }
  })

  const tools = {
    facetList: createFacetListTool(deps),
    facetSet: createFacetSetTool(deps),
    bodyPatch: createBodyPatchTool(deps),
    canvasRenderSvg: createCanvasRenderSvgTool(deps),
    canvasView: createCanvasViewTool(deps),
    canvasSnapshot: createCanvasSnapshotTool(deps),
    canvasEdit: createCanvasEditTool(deps),
    viewportSet: createViewportSetTool(deps),
    documentGet: createDocumentGetTool(deps),
    documentSearch: createDocumentSearchTool(deps, factsCache),
    documentSet: createDocumentSetTool(deps),
    versionSave: createVersionSaveTool(deps),
    versionList: createVersionListTool(deps),
    versionRestore: createVersionRestoreTool(deps),
  }
  return { app, tools: withResolvedWorkspaceHandles(tools, deps.documentIndex) }
}

function mapDocumentError(c: Context, err: unknown) {
  if (err instanceof WorkspaceDocumentNotFoundError) {
    return c.json({ error: err.message }, 404)
  }
  if (err instanceof WorkspaceNotFoundError) {
    return c.json({ error: err.message }, 404)
  }
  // The index's own spelling of the same condition: tools that call
  // `documentIndex.listDocuments` directly (backlinks, document-tags) let it
  // escape untranslated, and a typo'd workspaceId must read as 404, not 500.
  if (err instanceof PortWorkspaceNotFoundError) {
    return c.json({ error: err.message }, 404)
  }
  if (err instanceof DocumentPathTakenError) {
    return c.json({ error: err.message }, 409)
  }
  throw err
}
