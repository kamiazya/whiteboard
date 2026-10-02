import { createServer, type ServerDeps } from '@kamiazya/whiteboard-server-core'
import type { McpServer } from '@modelcontextprotocol/server'
import { gatedByMembership } from '../security/mcp-caller.js'
import { CANVAS_VIEW_RESOURCE_URI } from './mcp-apps.js'
import { registerToolWithAnnotations, structuredJsonResult } from './tool-support.js'

export function registerDocumentTools(server: McpServer, deps: ServerDeps): void {
  const tools = gatedByMembership(createServer(deps).tools, deps.documentIndex)

  // No lock is taken here. Every mutating tool holds the workspace write
  // lock itself, around its load-modify-save, through the LiveDocuments
  // seam (ADR-0018 §4: an adapter translates, it does not decide). It was
  // taken HERE for a while, keyed per document — so the same operations
  // reached over HTTP ran with no lock, and an agent write and a browser
  // update to one document were serialised on two different keys.
  // `write-lock.test.ts` in server-core pins that each tool takes it.

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
    tools.facetList.name,
    {
      description: tools.facetList.description,
      inputSchema: tools.facetList.inputSchema,
      outputSchema: tools.facetList.outputSchema,
    },
    async (args) => {
      // Read-only and document-independent: no write lock, no workspace.
      const result = await tools.facetList.execute(tools.facetList.inputSchema.parse(args))
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.facetSet.name,
    {
      description: tools.facetSet.description,
      inputSchema: tools.facetSet.inputSchema,
      outputSchema: tools.facetSet.outputSchema,
    },
    async (args) => {
      const parsed = tools.facetSet.inputSchema.parse(args)
      const result = await tools.facetSet.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.canvasRenderSvg.name,
    {
      description: tools.canvasRenderSvg.description,
      inputSchema: tools.canvasRenderSvg.inputSchema,
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
      inputSchema: tools.canvasView.inputSchema,
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
    tools.documentSearch.name,
    {
      description: tools.documentSearch.description,
      inputSchema: tools.documentSearch.inputSchema,
      outputSchema: tools.documentSearch.outputSchema,
    },
    async (args) => {
      const parsed = tools.documentSearch.inputSchema.parse(args)
      const result = await tools.documentSearch.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.documentGet.name,
    {
      description: tools.documentGet.description,
      inputSchema: tools.documentGet.inputSchema,
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
    tools.canvasSnapshot.name,
    {
      description: tools.canvasSnapshot.description,
      inputSchema: tools.canvasSnapshot.inputSchema,
      outputSchema: tools.canvasSnapshot.outputSchema,
    },
    async (args) => {
      const parsed = tools.canvasSnapshot.inputSchema.parse(args)
      const result = await tools.canvasSnapshot.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.viewportSet.name,
    {
      description: tools.viewportSet.description,
      inputSchema: tools.viewportSet.inputSchema,
      outputSchema: tools.viewportSet.outputSchema,
    },
    async (args) => {
      const parsed = tools.viewportSet.inputSchema.parse(args)
      // No document write lock: this changes nothing stored, it only asks a
      // browser to look somewhere. Queueing it behind an in-flight batch
      // would make "show me this" wait on an unrelated edit.
      const result = await tools.viewportSet.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.canvasEdit.name,
    {
      description: tools.canvasEdit.description,
      inputSchema: tools.canvasEdit.inputSchema,
      outputSchema: tools.canvasEdit.outputSchema,
    },
    async (args) => {
      const parsed = tools.canvasEdit.inputSchema.parse(args)
      const result = await tools.canvasEdit.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.threadEdit.name,
    {
      description: tools.threadEdit.description,
      inputSchema: tools.threadEdit.inputSchema,
      outputSchema: tools.threadEdit.outputSchema,
    },
    async (args) => {
      const parsed = tools.threadEdit.inputSchema.parse(args)
      const result = await tools.threadEdit.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.versionSave.name,
    {
      description: tools.versionSave.description,
      inputSchema: tools.versionSave.inputSchema,
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
      description: tools.versionList.description,
      inputSchema: tools.versionList.inputSchema,
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
      inputSchema: tools.versionRestore.inputSchema,
      outputSchema: tools.versionRestore.outputSchema,
    },
    async (args) => {
      const parsed = tools.versionRestore.inputSchema.parse(args)
      const result = await tools.versionRestore.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.bodyEdit.name,
    {
      description: tools.bodyEdit.description,
      inputSchema: tools.bodyEdit.inputSchema,
      outputSchema: tools.bodyEdit.outputSchema,
    },
    async (args) => {
      const parsed = tools.bodyEdit.inputSchema.parse(args)
      const result = await tools.bodyEdit.execute(parsed)
      return structuredJsonResult(result)
    },
  )

  // The ONE front door onto document create / set / delete. The standalone
  // `wb_document_create`, `wb_document_set` and `wb_document_delete` tools
  // were retired into its ops: two ways to do one thing is a tool table an
  // agent reads twice, and the batch is the shape that stops a five-document
  // errand costing five round trips. A single create pays for it in bytes,
  // not in calls — measured at +32 request / +106 response on one create.
  //
  // The OPERATIONS survive: `wbDocumentCreate` and friends still back these
  // ops and the `/api/v1` routes. Only the second front door is gone.
  registerToolWithAnnotations(
    server,
    tools.workspaceEdit.name,
    {
      description: tools.workspaceEdit.description,
      inputSchema: tools.workspaceEdit.inputSchema,
      outputSchema: tools.workspaceEdit.outputSchema,
    },
    async (args) => {
      const result = await tools.workspaceEdit.execute(tools.workspaceEdit.inputSchema.parse(args))
      return structuredJsonResult(result)
    },
  )

  // The read half of document CRUD. These have no Hono route counterpart
  // registered here, but they still come from `createServer`'s tool record
  // rather than from the bare operations, so the handle resolution that
  // record carries applies.
  registerToolWithAnnotations(
    server,
    tools.documentList.name,
    {
      description: tools.documentList.description,
      inputSchema: tools.documentList.inputSchema,
      outputSchema: tools.documentList.outputSchema,
    },
    async (args) => {
      const result = await tools.documentList.execute(tools.documentList.inputSchema.parse(args))
      return structuredJsonResult(result)
    },
  )
}
