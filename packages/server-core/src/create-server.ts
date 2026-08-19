import { DocumentPathTakenError } from '@kamiazya/whiteboard-ports'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { ServerDeps } from './server-deps.js'
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
import { createDocumentSetTool } from './tools/document-set.js'
import { exportOkf, exportOkfInputSchema } from './tools/export-okf.js'
import { createFacetSetTool } from './tools/facet-set.js'
import { createVersionListTool } from './tools/version-list.js'
import { createVersionRestoreTool } from './tools/version-restore.js'
import { createVersionSaveTool } from './tools/version-save.js'
import { createViewportSetTool } from './tools/viewport-set.js'

export function createServer(deps: ServerDeps) {
  const app = new Hono()

  app.post('/api/v1/workspaces/:workspaceId/documents', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = wbDocumentCreateInputSchema.safeParse({
      workspaceId: c.req.param('workspaceId'),
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
    const parsed = wbDocumentListInputSchema.safeParse({ workspaceId: c.req.param('workspaceId') })
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
      workspaceId: c.req.param('workspaceId'),
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
      workspaceId: c.req.param('workspaceId'),
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
  app.get('/api/v1/workspaces/:workspaceId/documents/:documentId/okf', async (c) => {
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
      // `mapDocumentError` only knows document-crud's index-level errors, so
      // the store-level miss is answered here.
      if (err instanceof SnapshotNotFoundError) {
        return c.json({ error: err.message }, 404)
      }
      return mapDocumentError(c, err)
    }
  })

  const tools = {
    facetSet: createFacetSetTool(deps),
    bodyPatch: createBodyPatchTool(deps),
    canvasRenderSvg: createCanvasRenderSvgTool(deps),
    canvasView: createCanvasViewTool(deps),
    canvasSnapshot: createCanvasSnapshotTool(deps),
    canvasEdit: createCanvasEditTool(deps),
    viewportSet: createViewportSetTool(deps),
    documentGet: createDocumentGetTool(deps),
    documentSet: createDocumentSetTool(deps),
    versionSave: createVersionSaveTool(deps),
    versionList: createVersionListTool(deps),
    versionRestore: createVersionRestoreTool(deps),
  }
  return { app, tools }
}

function mapDocumentError(c: Context, err: unknown) {
  if (err instanceof WorkspaceDocumentNotFoundError) {
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
