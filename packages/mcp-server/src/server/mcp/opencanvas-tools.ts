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
  wbCanvasCreate,
  wbCanvasDelete,
  wbCanvasGet,
  wbCanvasList,
} from '@kamiazya/whiteboard-server-core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
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
  registerZodObjectTool(server, tools.versionSave)
  registerZodObjectTool(server, tools.versionList)
  registerZodObjectTool(server, tools.versionRestore)

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
  registerZodObjectTool(server, {
    name: 'wb_canvas_create',
    inputSchema: createCanvasInputSchema,
    outputSchema: createCanvasOutputSchema,
    execute: (input) => wbCanvasCreate(deps, input),
  })
  registerZodObjectTool(server, {
    name: 'wb_canvas_list',
    inputSchema: listCanvasesInputSchema,
    outputSchema: listCanvasesOutputSchema,
    execute: (input) => wbCanvasList(deps, input),
  })
  registerZodObjectTool(server, {
    name: 'wb_canvas_get',
    inputSchema: getCanvasInputSchema,
    outputSchema: getCanvasOutputSchema,
    execute: (input) => wbCanvasGet(deps, input),
  })
  registerZodObjectTool(server, {
    name: 'wb_canvas_delete',
    inputSchema: deleteCanvasInputSchema,
    outputSchema: deleteCanvasOutputSchema,
    execute: (input) => wbCanvasDelete(deps, input),
  })
}
