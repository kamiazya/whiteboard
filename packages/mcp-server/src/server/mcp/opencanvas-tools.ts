import {
  createCanvasInputSchema,
  createCanvasOutputSchema,
  createServer,
  deleteCanvasInputSchema,
  deleteCanvasOutputSchema,
  getCanvasInputSchema,
  getCanvasOutputSchema,
  listCanvasesInputSchema,
  listCanvasesOutputSchema,
  type ServerDeps,
  setLogSink as setServerCoreLogSink,
  WB_DOCUMENT_CREATE_DESCRIPTION,
  WB_DOCUMENT_DELETE_DESCRIPTION,
  WB_DOCUMENT_LIST_DESCRIPTION,
  WB_DOCUMENT_RESOLVE_DESCRIPTION,
  wbCanvasCreate,
  wbCanvasDelete,
  wbCanvasGet,
  wbCanvasList,
} from '@kamiazya/whiteboard-server-core'
import type { McpServer } from '@modelcontextprotocol/server'
import type { z } from 'zod'
import { getLogger } from '../log.js'
import { withCanvasDocWriteLock } from '../store/workspace-lock.js'
import { CANVAS_VIEW_RESOURCE_URI } from './mcp-apps.js'
import { registerToolWithAnnotations, structuredJsonResult } from './tool-support.js'

// server-core is a shared layer and cannot depend on this composition
// root's pino-backed logger, so it exposes an injectable sink instead
// (see server-core/src/log.ts). Without this call, any fail-open log site
// in server-core silently drops its record — the failure becomes invisible
// to operators even though the code path itself never throws.
// Levels are named identically (RFC 5424) on both sides, so this is a
// straight pass-through rather than a mapping. mcp-server's pino-backed
// logger takes the structured payload before the message (pino's own
// convention), the reverse order of server-core's LogRecord shape.
setServerCoreLogSink((record) => {
  const log = getLogger(record.scope)
  if (record.data) {
    log[record.level](record.data, record.msg)
  } else {
    log[record.level](record.msg)
  }
})

export function registerOpenCanvasTools(server: McpServer, deps: ServerDeps): void {
  const { tools } = createServer(deps)

  // Every MUTATING tool below runs inside withCanvasDocWriteLock, keyed on
  // the canvas it targets. Each is a load-modify-save against
  // canvasDocStore, whose saveSnapshot writes unconditionally, so two calls
  // that load the same base before either saves silently drop one of the
  // changes (see canvas-doc-write-lock.test.ts, which demonstrates the loss
  // on the real tools). Read-only tools are deliberately NOT wrapped:
  // serializing reads behind writes would make a render or digest wait on
  // an unrelated patch for no correctness gain.
  //
  // The lock wraps the execute() call rather than the registration, so the
  // concrete outputSchema/O binding described below is untouched.

  // Each call below is a direct registerToolWithAnnotations invocation (not
  // routed through a shared generic wrapper) so outputSchema and O are
  // concrete at every call site: TypeScript checks this handler's
  // structuredJsonResult(result) return against ToolHandlerReturn<O> for
  // real, with no cast. A shared generic helper cannot do this: inside a
  // generic function body O stays an abstract type parameter, so the
  // conditional ToolHandlerReturn<O> never resolves and the check silently
  // degrades into an `as unknown as` cast.
  registerToolWithAnnotations(
    server,
    tools.facetSet.name,
    {
      description: tools.facetSet.description,
      inputSchema: tools.facetSet.inputSchema.shape,
      outputSchema: tools.facetSet.outputSchema,
    },
    async (args) => {
      const parsed = tools.facetSet.inputSchema.parse(args)
      const result = await withCanvasDocWriteLock(parsed.canvasId, () =>
        tools.facetSet.execute(parsed),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.nodeAdd.name,
    {
      description: tools.nodeAdd.description,
      inputSchema: tools.nodeAdd.inputSchema.shape,
      outputSchema: tools.nodeAdd.outputSchema,
    },
    async (args) => {
      const parsed = tools.nodeAdd.inputSchema.parse(args)
      const result = await withCanvasDocWriteLock(parsed.canvasId, () =>
        tools.nodeAdd.execute(parsed),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.nodePatch.name,
    {
      description: tools.nodePatch.description,
      inputSchema: tools.nodePatch.inputSchema.shape,
      outputSchema: tools.nodePatch.outputSchema,
    },
    async (args) => {
      const parsed = tools.nodePatch.inputSchema.parse(args)
      const result = await withCanvasDocWriteLock(parsed.canvasId, () =>
        tools.nodePatch.execute(parsed),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.nodeLock.name,
    {
      description: tools.nodeLock.description,
      inputSchema: tools.nodeLock.inputSchema.shape,
      outputSchema: tools.nodeLock.outputSchema,
    },
    async (args) => {
      const parsed = tools.nodeLock.inputSchema.parse(args)
      const result = await withCanvasDocWriteLock(parsed.canvasId, () =>
        tools.nodeLock.execute(parsed),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.edgeLock.name,
    {
      description: tools.edgeLock.description,
      inputSchema: tools.edgeLock.inputSchema.shape,
      outputSchema: tools.edgeLock.outputSchema,
    },
    async (args) => {
      const parsed = tools.edgeLock.inputSchema.parse(args)
      const result = await withCanvasDocWriteLock(parsed.canvasId, () =>
        tools.edgeLock.execute(parsed),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.edgeAdd.name,
    {
      description: tools.edgeAdd.description,
      inputSchema: tools.edgeAdd.inputSchema.shape,
      outputSchema: tools.edgeAdd.outputSchema,
    },
    async (args) => {
      const parsed = tools.edgeAdd.inputSchema.parse(args)
      const result = await withCanvasDocWriteLock(parsed.canvasId, () =>
        tools.edgeAdd.execute(parsed),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.edgePatch.name,
    {
      description: tools.edgePatch.description,
      inputSchema: tools.edgePatch.inputSchema.shape,
      outputSchema: tools.edgePatch.outputSchema,
    },
    async (args) => {
      const parsed = tools.edgePatch.inputSchema.parse(args)
      const result = await withCanvasDocWriteLock(parsed.canvasId, () =>
        tools.edgePatch.execute(parsed),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.tidyCanvas.name,
    {
      description: tools.tidyCanvas.description,
      inputSchema: tools.tidyCanvas.inputSchema.shape,
      outputSchema: tools.tidyCanvas.outputSchema,
    },
    async (args) => {
      const parsed = tools.tidyCanvas.inputSchema.parse(args)
      const result = await withCanvasDocWriteLock(parsed.canvasId, () =>
        tools.tidyCanvas.execute(parsed),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.canvasRenderSvg.name,
    {
      description: tools.canvasRenderSvg.description,
      inputSchema: tools.canvasRenderSvg.inputSchema.shape,
      outputSchema: tools.canvasRenderSvg.outputSchema,
    },
    async (args) => {
      const parsed = tools.canvasRenderSvg.inputSchema.parse(args)
      const result = await tools.canvasRenderSvg.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  // The one UI-linked tool: `_meta.ui.resourceUri` is what makes an
  // MCP Apps host render the result through the canvas-view widget instead
  // of printing its JSON. Without this line the widget resource stays
  // registered and unreachable, which is the state this repo was in.
  registerToolWithAnnotations(
    server,
    tools.canvasView.name,
    {
      description: tools.canvasView.description,
      inputSchema: tools.canvasView.inputSchema.shape,
      outputSchema: tools.canvasView.outputSchema,
      _meta: { ui: { resourceUri: CANVAS_VIEW_RESOURCE_URI } },
    },
    async (args) => {
      const parsed = tools.canvasView.inputSchema.parse(args)
      const result = await tools.canvasView.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.documentGet.name,
    {
      description: tools.documentGet.description,
      inputSchema: tools.documentGet.inputSchema.shape,
      outputSchema: tools.documentGet.outputSchema,
    },
    async (args) => {
      const parsed = tools.documentGet.inputSchema.parse(args)
      const result = await tools.documentGet.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.canvasDigest.name,
    {
      description: tools.canvasDigest.description,
      inputSchema: tools.canvasDigest.inputSchema.shape,
      outputSchema: tools.canvasDigest.outputSchema,
    },
    async (args) => {
      const parsed = tools.canvasDigest.inputSchema.parse(args)
      const result = await tools.canvasDigest.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.versionSave.name,
    {
      description: tools.versionSave.description,
      inputSchema: tools.versionSave.inputSchema.shape,
      outputSchema: tools.versionSave.outputSchema,
    },
    async (args) => {
      const parsed = tools.versionSave.inputSchema.parse(args)
      const result = await withCanvasDocWriteLock(parsed.canvasId, () =>
        tools.versionSave.execute(parsed),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.versionList.name,
    {
      description: tools.versionList.description,
      inputSchema: tools.versionList.inputSchema.shape,
      outputSchema: tools.versionList.outputSchema,
    },
    async (args) => {
      const parsed = tools.versionList.inputSchema.parse(args)
      const result = await tools.versionList.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.versionRestore.name,
    {
      description: tools.versionRestore.description,
      inputSchema: tools.versionRestore.inputSchema.shape,
      outputSchema: tools.versionRestore.outputSchema,
    },
    async (args) => {
      const parsed = tools.versionRestore.inputSchema.parse(args)
      const result = await withCanvasDocWriteLock(parsed.canvasId, () =>
        tools.versionRestore.execute(parsed),
      )
      return structuredJsonResult(result)
    },
  )

  // wb_body_patch uses z.discriminatedUnion — flatten its options into a
  // raw shape so registerToolWithAnnotations can consume it.
  const bp = tools.bodyPatch
  const bpOptions = bp.inputSchema.options
  const flatShape = Object.assign({}, ...bpOptions.map((o) => o.shape)) as z.ZodRawShape
  registerToolWithAnnotations(
    server,
    bp.name,
    { description: bp.description, inputSchema: flatShape, outputSchema: bp.outputSchema },
    async (args) => {
      const parsed = bp.inputSchema.parse(args)
      const result = await bp.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.documentSet.name,
    {
      description: tools.documentSet.description,
      inputSchema: tools.documentSet.inputSchema.shape,
      outputSchema: tools.documentSet.outputSchema,
    },
    async (args) => {
      const parsed = tools.documentSet.inputSchema.parse(args)
      const result = await withCanvasDocWriteLock(parsed.canvasId, () =>
        tools.documentSet.execute(parsed),
      )
      return structuredJsonResult(result)
    },
  )

  // Canvas CRUD (wired as standalone MCP tools, not through createServer's Hono routes)
  registerToolWithAnnotations(
    server,
    'wb_document_create',
    {
      description: WB_DOCUMENT_CREATE_DESCRIPTION,
      inputSchema: createCanvasInputSchema.shape,
      outputSchema: createCanvasOutputSchema,
    },
    async (args) => {
      const parsed = createCanvasInputSchema.parse(args)
      const result = await wbCanvasCreate(deps, parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    'wb_document_list',
    {
      description: WB_DOCUMENT_LIST_DESCRIPTION,
      inputSchema: listCanvasesInputSchema.shape,
      outputSchema: listCanvasesOutputSchema,
    },
    async (args) => {
      const parsed = listCanvasesInputSchema.parse(args)
      const result = await wbCanvasList(deps, parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    'wb_document_resolve',
    {
      description: WB_DOCUMENT_RESOLVE_DESCRIPTION,
      inputSchema: getCanvasInputSchema.shape,
      outputSchema: getCanvasOutputSchema,
    },
    async (args) => {
      const parsed = getCanvasInputSchema.parse(args)
      const result = await wbCanvasGet(deps, parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    'wb_document_delete',
    {
      description: WB_DOCUMENT_DELETE_DESCRIPTION,
      inputSchema: deleteCanvasInputSchema.shape,
      outputSchema: deleteCanvasOutputSchema,
    },
    async (args) => {
      const parsed = deleteCanvasInputSchema.parse(args)
      const result = await wbCanvasDelete(deps, parsed)
      return structuredJsonResult(result)
    },
  )
}
