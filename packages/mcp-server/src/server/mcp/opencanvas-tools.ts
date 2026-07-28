import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  createServer,
  type ServerDeps,
  createCanvasInputSchema,
  createCanvasOutputSchema,
  listCanvasesInputSchema,
  listCanvasesOutputSchema,
  getCanvasInputSchema,
  getCanvasOutputSchema,
  deleteCanvasInputSchema,
  deleteCanvasOutputSchema,
  wbCanvasCreate,
  wbCanvasList,
  wbCanvasGet,
  wbCanvasDelete,
} from '@kamiazya/whiteboard-server-core'
import type { z } from 'zod'
import {
  registerToolWithAnnotations,
  structuredJsonResult,
  type ToolHandlerReturn,
} from './tool-support.js'

function registerZodObjectTool<S extends z.ZodObject<z.ZodRawShape>, O extends z.ZodTypeAny>(
  server: McpServer,
  tool: {
    name: string
    inputSchema: S
    outputSchema: O
    execute: (input: z.infer<S>) => Promise<z.infer<O>>
  },
): void {
  registerToolWithAnnotations(
    server,
    tool.name,
    { inputSchema: tool.inputSchema.shape, outputSchema: tool.outputSchema },
    async (args) => {
      const parsed = tool.inputSchema.parse(args)
      const result = await tool.execute(parsed)
      return structuredJsonResult(result as object) as unknown as ToolHandlerReturn<O>
    },
  )
}

export function registerOpenCanvasTools(server: McpServer, deps: ServerDeps): void {
  const { tools } = createServer(deps)

  registerZodObjectTool(server, tools.facetSet)
  registerZodObjectTool(server, tools.nodePatch)
  registerZodObjectTool(server, tools.edgePatch)
  registerZodObjectTool(server, tools.canvasRenderSvg)
  registerZodObjectTool(server, tools.canvasDigest)
  registerZodObjectTool(server, tools.canvasExportOkf)
  registerZodObjectTool(server, tools.canvasExportJsonCanvas)

  // version_save / version_list / version_restore are already registered
  // via the legacy Excalidraw tool path (tool-registration.ts). Skipped
  // here to avoid double-registration; 7f-2 will retire the old path.

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
