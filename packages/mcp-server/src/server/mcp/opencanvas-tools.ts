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
  wbCanvasCreate,
  wbCanvasDelete,
  wbCanvasGet,
  wbCanvasList,
} from '@kamiazya/whiteboard-server-core'
import type { McpServer } from '@modelcontextprotocol/server'
import type { z } from 'zod'
import { getLogger } from '../log.js'
import { registerToolWithAnnotations, structuredJsonResult } from './tool-support.js'

// server-core is a shared layer and cannot depend on this composition
// root's pino-backed logger, so it exposes an injectable sink instead
// (see server-core/src/log.ts). Without this call, every fail-open log
// site in server-core (e.g. reindexWorkspace's derivation/applyRows error
// handling) silently drops its record — the failure becomes invisible to
// operators even though the code path itself never throws.
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
    { inputSchema: tools.facetSet.inputSchema.shape, outputSchema: tools.facetSet.outputSchema },
    async (args) => {
      const parsed = tools.facetSet.inputSchema.parse(args)
      const result = await tools.facetSet.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.nodePatch.name,
    { inputSchema: tools.nodePatch.inputSchema.shape, outputSchema: tools.nodePatch.outputSchema },
    async (args) => {
      const parsed = tools.nodePatch.inputSchema.parse(args)
      const result = await tools.nodePatch.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.nodeLock.name,
    { inputSchema: tools.nodeLock.inputSchema.shape, outputSchema: tools.nodeLock.outputSchema },
    async (args) => {
      const parsed = tools.nodeLock.inputSchema.parse(args)
      const result = await tools.nodeLock.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.edgeLock.name,
    { inputSchema: tools.edgeLock.inputSchema.shape, outputSchema: tools.edgeLock.outputSchema },
    async (args) => {
      const parsed = tools.edgeLock.inputSchema.parse(args)
      const result = await tools.edgeLock.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.edgePatch.name,
    { inputSchema: tools.edgePatch.inputSchema.shape, outputSchema: tools.edgePatch.outputSchema },
    async (args) => {
      const parsed = tools.edgePatch.inputSchema.parse(args)
      const result = await tools.edgePatch.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.canvasRenderSvg.name,
    {
      inputSchema: tools.canvasRenderSvg.inputSchema.shape,
      outputSchema: tools.canvasRenderSvg.outputSchema,
    },
    async (args) => {
      const parsed = tools.canvasRenderSvg.inputSchema.parse(args)
      const result = await tools.canvasRenderSvg.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.canvasDigest.name,
    {
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
    tools.canvasExportOkf.name,
    {
      inputSchema: tools.canvasExportOkf.inputSchema.shape,
      outputSchema: tools.canvasExportOkf.outputSchema,
    },
    async (args) => {
      const parsed = tools.canvasExportOkf.inputSchema.parse(args)
      const result = await tools.canvasExportOkf.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.canvasExportJsonCanvas.name,
    {
      inputSchema: tools.canvasExportJsonCanvas.inputSchema.shape,
      outputSchema: tools.canvasExportJsonCanvas.outputSchema,
    },
    async (args) => {
      const parsed = tools.canvasExportJsonCanvas.inputSchema.parse(args)
      const result = await tools.canvasExportJsonCanvas.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.versionSave.name,
    {
      inputSchema: tools.versionSave.inputSchema.shape,
      outputSchema: tools.versionSave.outputSchema,
    },
    async (args) => {
      const parsed = tools.versionSave.inputSchema.parse(args)
      const result = await tools.versionSave.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.versionList.name,
    {
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
      inputSchema: tools.versionRestore.inputSchema.shape,
      outputSchema: tools.versionRestore.outputSchema,
    },
    async (args) => {
      const parsed = tools.versionRestore.inputSchema.parse(args)
      const result = await tools.versionRestore.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  // body_patch uses z.discriminatedUnion — flatten its options into a
  // raw shape so registerToolWithAnnotations can consume it.
  const bp = tools.bodyPatch
  const bpOptions = bp.inputSchema.options
  const flatShape = Object.assign({}, ...bpOptions.map((o) => o.shape)) as z.ZodRawShape
  registerToolWithAnnotations(
    server,
    bp.name,
    { inputSchema: flatShape, outputSchema: bp.outputSchema },
    async (args) => {
      const parsed = bp.inputSchema.parse(args)
      const result = await bp.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.canvasImportOkf.name,
    {
      inputSchema: tools.canvasImportOkf.inputSchema.shape,
      outputSchema: tools.canvasImportOkf.outputSchema,
    },
    async (args) => {
      const parsed = tools.canvasImportOkf.inputSchema.parse(args)
      const result = await tools.canvasImportOkf.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  // Canvas CRUD (wired as standalone MCP tools, not through createServer's Hono routes)
  registerToolWithAnnotations(
    server,
    'wb_canvas_create',
    { inputSchema: createCanvasInputSchema.shape, outputSchema: createCanvasOutputSchema },
    async (args) => {
      const parsed = createCanvasInputSchema.parse(args)
      const result = await wbCanvasCreate(deps, parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    'wb_canvas_list',
    { inputSchema: listCanvasesInputSchema.shape, outputSchema: listCanvasesOutputSchema },
    async (args) => {
      const parsed = listCanvasesInputSchema.parse(args)
      const result = await wbCanvasList(deps, parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    'wb_canvas_get',
    { inputSchema: getCanvasInputSchema.shape, outputSchema: getCanvasOutputSchema },
    async (args) => {
      const parsed = getCanvasInputSchema.parse(args)
      const result = await wbCanvasGet(deps, parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    'wb_canvas_delete',
    { inputSchema: deleteCanvasInputSchema.shape, outputSchema: deleteCanvasOutputSchema },
    async (args) => {
      const parsed = deleteCanvasInputSchema.parse(args)
      const result = await wbCanvasDelete(deps, parsed)
      return structuredJsonResult(result)
    },
  )
}
