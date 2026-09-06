import {
  createServer,
  type ServerDeps,
  setLogSink as setServerCoreLogSink,
} from '@kamiazya/whiteboard-server-core'
import type { McpServer } from '@modelcontextprotocol/server'
import { getLogger } from '../log.js'
import { withDocumentWriteLock } from '../store/workspace-lock.js'
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

export function registerDocumentTools(server: McpServer, deps: ServerDeps): void {
  const { tools } = createServer(deps)

  // Every MUTATING tool below runs inside withDocumentWriteLock, keyed on
  // the canvas it targets. Each is a load-modify-save against
  // documentStore, whose saveSnapshot writes unconditionally, so two calls
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
    tools.facetList.name,
    {
      description: tools.facetList.description,
      inputSchema: tools.facetList.inputSchema.shape,
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
      inputSchema: tools.facetSet.inputSchema.shape,
      outputSchema: tools.facetSet.outputSchema,
    },
    async (args) => {
      const parsed = tools.facetSet.inputSchema.parse(args)
      const result = await withDocumentWriteLock(parsed.documentId, () =>
        tools.facetSet.execute(parsed),
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
    tools.documentSearch.name,
    {
      description: tools.documentSearch.description,
      inputSchema: tools.documentSearch.inputSchema.shape,
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
    tools.canvasSnapshot.name,
    {
      description: tools.canvasSnapshot.description,
      inputSchema: tools.canvasSnapshot.inputSchema.shape,
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
      inputSchema: tools.viewportSet.inputSchema.shape,
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
      inputSchema: tools.canvasEdit.inputSchema.shape,
      outputSchema: tools.canvasEdit.outputSchema,
    },
    async (args) => {
      const parsed = tools.canvasEdit.inputSchema.parse(args)
      // Under the per-document write lock: this is the one tool that reads
      // the whole canvas, decides ids and placements against what it read,
      // and writes it back. Two concurrent batches without the lock can
      // mint the same id and the later save wins silently.
      const result = await withDocumentWriteLock(parsed.documentId, () =>
        tools.canvasEdit.execute(parsed),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.threadEdit.name,
    {
      description: tools.threadEdit.description,
      inputSchema: tools.threadEdit.inputSchema.shape,
      outputSchema: tools.threadEdit.outputSchema,
    },
    async (args) => {
      const parsed = tools.threadEdit.inputSchema.parse(args)
      // Same lock as wb_canvas_edit, for the same reason one level in: this
      // reads the threads the document holds, mints ids against what it read,
      // and saves the whole snapshot back. Two concurrent batches without it
      // mint the same thread id and the later save wins silently.
      const result = await withDocumentWriteLock(parsed.documentId, () =>
        tools.threadEdit.execute(parsed),
      )
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
      const result = await withDocumentWriteLock(parsed.documentId, () =>
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
      const result = await withDocumentWriteLock(parsed.documentId, () =>
        tools.versionRestore.execute(parsed),
      )
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
      const result = await withDocumentWriteLock(parsed.documentId, () =>
        tools.bodyEdit.execute(parsed),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.bodyPatch.name,
    {
      description: tools.bodyPatch.description,
      inputSchema: tools.bodyPatch.inputSchema,
      outputSchema: tools.bodyPatch.outputSchema,
    },
    async (args) => {
      const parsed = tools.bodyPatch.inputSchema.parse(args)
      const result = await withDocumentWriteLock(parsed.documentId, () =>
        tools.bodyPatch.execute(parsed),
      )
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
      const result = await withDocumentWriteLock(parsed.documentId, () =>
        tools.documentSet.execute(parsed),
      )
      return structuredJsonResult(result)
    },
  )

  // One call for several documents. Separate from wb_document_create rather
  // than replacing it: a single create is the common case and should not
  // have to be wrapped in an ops array to happen.
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

  // Document CRUD. These have no Hono route counterpart registered here, but
  // they still come from `createServer`'s tool record rather than from the
  // bare operations, so the handle resolution that record carries applies.
  registerToolWithAnnotations(
    server,
    tools.documentCreate.name,
    {
      description: tools.documentCreate.description,
      inputSchema: tools.documentCreate.inputSchema,
      outputSchema: tools.documentCreate.outputSchema,
    },
    async (args) => {
      const result = await tools.documentCreate.execute(
        tools.documentCreate.inputSchema.parse(args),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.documentList.name,
    {
      description: tools.documentList.description,
      inputSchema: tools.documentList.inputSchema.shape,
      outputSchema: tools.documentList.outputSchema,
    },
    async (args) => {
      const result = await tools.documentList.execute(tools.documentList.inputSchema.parse(args))
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.documentResolve.name,
    {
      description: tools.documentResolve.description,
      inputSchema: tools.documentResolve.inputSchema.shape,
      outputSchema: tools.documentResolve.outputSchema,
    },
    async (args) => {
      const result = await tools.documentResolve.execute(
        tools.documentResolve.inputSchema.parse(args),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(
    server,
    tools.documentDelete.name,
    {
      description: tools.documentDelete.description,
      inputSchema: tools.documentDelete.inputSchema.shape,
      outputSchema: tools.documentDelete.outputSchema,
    },
    async (args) => {
      const result = await tools.documentDelete.execute(
        tools.documentDelete.inputSchema.parse(args),
      )
      return structuredJsonResult(result)
    },
  )
}
