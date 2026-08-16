import { DocumentPathTakenError } from '@kamiazya/whiteboard-canvas-ports'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { CanvasNotFoundError as SnapshotNotFoundError } from './render/load-spatial-canvas.js'
import type { ServerDeps } from './server-deps.js'
import { createBodyPatchTool } from './tools/body-patch.js'
import { CanvasNotFoundError, WorkspaceNotFoundError } from './tools/canvas-crud.errors.js'
import { wbCanvasCreate, wbCanvasDelete, wbCanvasGet, wbCanvasList } from './tools/canvas-crud.js'
import {
  createCanvasInputSchema,
  deleteCanvasInputSchema,
  getCanvasInputSchema,
  listCanvasesInputSchema,
} from './tools/canvas-crud.schemas.js'
import { createCanvasDigestTool } from './tools/canvas-digest.js'
import { createCanvasRenderSvgTool } from './tools/canvas-render-svg.js'
import { createCanvasViewTool } from './tools/canvas-view.js'
import { createDocumentGetTool } from './tools/document-get.js'
import { createDocumentSetTool } from './tools/document-set.js'
import { createEdgeAddTool } from './tools/edge-add.js'
import { createEdgeLockTool } from './tools/edge-lock.js'
import { createEdgePatchTool } from './tools/edge-patch.js'
import { DocumentNotFoundError } from './tools/errors.js'
import { exportOkf, exportOkfInputSchema } from './tools/export-okf.js'
import { createFacetSetTool } from './tools/facet-set.js'
import { createNodeAddTool } from './tools/node-add.js'
import { createNodeLockTool } from './tools/node-lock.js'
import { createNodePatchTool } from './tools/node-patch.js'
import { createTidyCanvasTool } from './tools/tidy-canvas.js'
import { createVersionListTool } from './tools/version-list.js'
import { createVersionRestoreTool } from './tools/version-restore.js'
import { createVersionSaveTool } from './tools/version-save.js'

export function createServer(deps: ServerDeps) {
  const app = new Hono()

  app.post('/api/v1/workspaces/:workspaceId/canvases', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = createCanvasInputSchema.safeParse({
      workspaceId: c.req.param('workspaceId'),
      ...body,
    })
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    try {
      const result = await wbCanvasCreate(deps, parsed.data)
      return c.json(result, 201)
    } catch (err) {
      return mapCanvasError(c, err)
    }
  })

  app.get('/api/v1/workspaces/:workspaceId/canvases', async (c) => {
    const parsed = listCanvasesInputSchema.safeParse({ workspaceId: c.req.param('workspaceId') })
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    try {
      const result = await wbCanvasList(deps, parsed.data)
      return c.json(result, 200)
    } catch (err) {
      return mapCanvasError(c, err)
    }
  })

  app.get('/api/v1/workspaces/:workspaceId/canvases/:documentId', async (c) => {
    const parsed = getCanvasInputSchema.safeParse({
      workspaceId: c.req.param('workspaceId'),
      documentId: c.req.param('documentId'),
    })
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    try {
      const result = await wbCanvasGet(deps, parsed.data)
      return c.json(result, 200)
    } catch (err) {
      return mapCanvasError(c, err)
    }
  })

  app.delete('/api/v1/workspaces/:workspaceId/canvases/:documentId', async (c) => {
    const parsed = deleteCanvasInputSchema.safeParse({
      workspaceId: c.req.param('workspaceId'),
      documentId: c.req.param('documentId'),
    })
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    try {
      const result = await wbCanvasDelete(deps, parsed.data)
      return c.json(result, 200)
    } catch (err) {
      return mapCanvasError(c, err)
    }
  })

  // Read-only OKF projection of one document, over HTTP so a browsing UI
  // (workspace file tree) can open one without an MCP client. Deliberately
  // still OKF-specific: this is a different surface from the MCP tools, and
  // the tree wants markdown regardless of what wb_document_get would choose.
  app.get('/api/v1/workspaces/:workspaceId/canvases/:documentId/okf', async (c) => {
    const parsed = exportOkfInputSchema.safeParse({
      workspaceId: c.req.param('workspaceId'),
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
      // Note: loadSpatialCanvas throws its own CanvasNotFoundError class,
      // distinct from canvas-crud's; mapCanvasError only knows the latter.
      if (err instanceof SnapshotNotFoundError || err instanceof DocumentNotFoundError) {
        return c.json({ error: err.message }, 404)
      }
      return mapCanvasError(c, err)
    }
  })

  const tools = {
    facetSet: createFacetSetTool(deps),
    nodeLock: createNodeLockTool(deps),
    edgeLock: createEdgeLockTool(deps),
    nodeAdd: createNodeAddTool(deps),
    nodePatch: createNodePatchTool(deps),
    edgeAdd: createEdgeAddTool(deps),
    edgePatch: createEdgePatchTool(deps),
    tidyCanvas: createTidyCanvasTool(deps),
    bodyPatch: createBodyPatchTool(deps),
    canvasRenderSvg: createCanvasRenderSvgTool(deps),
    canvasView: createCanvasViewTool(deps),
    canvasDigest: createCanvasDigestTool(deps),
    documentGet: createDocumentGetTool(deps),
    documentSet: createDocumentSetTool(deps),
    versionSave: createVersionSaveTool(deps),
    versionList: createVersionListTool(deps),
    versionRestore: createVersionRestoreTool(deps),
  }
  return { app, tools }
}

function mapCanvasError(c: Context, err: unknown) {
  if (err instanceof CanvasNotFoundError) {
    return c.json({ error: err.message }, 404)
  }
  if (err instanceof WorkspaceNotFoundError) {
    return c.json({ error: err.message }, 404)
  }
  if (err instanceof DocumentPathTakenError) {
    return c.json({ error: err.message }, 409)
  }
  throw err
}
