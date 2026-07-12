import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { createDaemonClient } from './daemon-client.js'
import {
  registerToolWithAnnotations,
  structuredJsonResult,
  type ToolHandlerReturn,
} from './tool-support.js'
import {
  annotateBatchInputShape,
  annotateBatchOutputSchema,
  annotateBatchTool,
} from './tools/annotate-batch.js'
import { annotateInputShape, annotateOutputSchema, annotateTool } from './tools/annotate.js'
import {
  canvasAutoLayoutInputShape,
  canvasAutoLayoutOutputSchema,
  canvasAutoLayoutTool,
} from './tools/canvas-auto-layout.js'
import {
  canvasExportJsonInputShape,
  canvasExportJsonOutputSchema,
  canvasExportJsonTool,
} from './tools/canvas-export-json.js'
import {
  canvasInspectInputShape,
  canvasInspectOutputSchema,
  canvasInspectTool,
} from './tools/canvas-inspect.js'
import {
  canvasCreateInputShape,
  canvasCreateOutputSchema,
  canvasListInputShape,
  canvasListOutputSchema,
  canvasOpenInputShape,
  canvasOpenOutputSchema,
  createCanvasTool,
  listCanvasTool,
  openCanvasTool,
  optimizeCanvasesInputShape,
  optimizeCanvasesOutputSchema,
  optimizeCanvasesTool,
} from './tools/canvas.js'
import {
  alignElementsTool,
  alignInputSchema,
  alignOutputSchema,
  assignGroupOutputSchema,
  assignToGroupInputShape,
  assignToGroupTool,
  canvasClearInputShape,
  canvasClearTool,
  clearedCountOutputSchema,
  deleteElementInputShape,
  deletedElementsOutputSchema,
  deleteElementsInputShape,
  deleteElementsTool,
  deleteElementTool,
  deleteGroupInputShape,
  deleteGroupTool,
  distributeElementsTool,
  distributeInputSchema,
  distributeOutputSchema,
  elementIdOutputSchema,
  elementIdsOutputSchema,
  listGroupsInputShape,
  listGroupsOutputSchema,
  listGroupsTool,
  moveElementsInputShape,
  moveElementsTool,
  reorderElementsInputShape,
  reorderElementsTool,
  reorderOutputSchema,
  updateElementInputShape,
  updateElementTool,
} from './tools/element-ops-tools.js'
import {
  exportCanvasInputShape,
  exportCanvasOutputSchema,
  exportCanvasTool,
} from './tools/export-canvas.js'
import { exportSvgInputShape, exportSvgOutputSchema, exportSvgTool } from './tools/export-svg.js'
import { exportPngInputShape, exportPngOutputSchema, exportPngTool } from './tools/export.js'
import {
  versionListInputShape,
  versionListOutputSchema,
  versionListTool,
  versionRestoreInputShape,
  versionRestoreOutputSchema,
  versionRestoreTool,
  versionSaveInputShape,
  versionSaveOutputSchema,
  versionSaveTool,
} from './tools/version.js'
import {
  createEmbedInputShape,
  createEmbedOutputSchema,
  createEmbedTool,
  createFrameInputShape,
  createFrameOutputSchema,
  createFrameTool,
  updateFrameMembersInputShape,
  updateFrameMembersOutputSchema,
  updateFrameMembersTool,
} from './tools/frame-embed.js'
import {
  libraryCatalogListInputShape,
  libraryCatalogListOutputSchema,
  libraryCatalogListTool,
} from './tools/library-catalog.js'
import {
  installedUrlsOutputSchema,
  libInsertItemOutputSchema,
  libraryInsertBatchInputShape,
  libraryInsertBatchOutputSchema,
  libraryInsertBatchTool,
  libraryInsertItemInputShape,
  libraryInsertItemTool,
  libraryInstallInputShape,
  libraryInstallOutputSchema,
  libraryInstallTool,
  libraryListInstalledInputShape,
  libraryListInstalledTool,
  libraryListItemsInputShape,
  libraryListItemsOutputSchema,
  libraryListItemsTool,
  libraryUninstallInputShape,
  libraryUninstallTool,
  userLibraryListInputShape,
  userLibraryListOutputSchema,
  userLibraryListTool,
  userLibraryMetadataDeleteInputShape,
  userLibraryMetadataDeleteTool,
  userLibraryMetadataGetInputShape,
  userLibraryMetadataGetTool,
  userLibraryMetadataManifestSchema,
  userLibraryMetadataSetInputShape,
  userLibraryMetadataSetTool,
  userLibraryRemoveInputShape,
  userLibraryRemoveOutputSchema,
  userLibraryRemoveTool,
  userLibrarySaveInputShape,
  userLibrarySaveOutputSchema,
  userLibrarySaveTool,
} from './tools/library.js'
import { loadImageInputShape, loadImageOutputSchema, loadImageTool } from './tools/load.js'
import {
  paletteDeleteInputShape,
  paletteDeleteTool,
  paletteGetInputShape,
  paletteGetTool,
  paletteOutputSchema,
  paletteSetInputShape,
  paletteSetTool,
} from './tools/palette.js'
import {
  buildPairingLinkText,
  createPairingLinkInputShape,
  createPairingLinkOutputSchema,
  pairingLinkTool,
} from './tools/pairing-link.js'
import {
  insertTemplateInputShape,
  insertTemplateTool,
  listTemplatesInputShape,
  listTemplatesTool,
  templateInsertOutputSchema,
  templateListOutputSchema,
} from './tools/template.js'
import {
  viewportSetInputShape,
  viewportSetOutputSchema,
  viewportSetTool,
} from './tools/viewport.js'

// A registered-tool entry, already bound to McpServer at construction time.
// The array below is necessarily heterogeneous (48 different I/O generic
// pairs), so this is the erased/existential form of each entry — but the
// erasure happens only AFTER defineTool() below has type-checked the
// handler against ToolHandlerReturn<O> for that specific entry.
type RegisteredTool = (server: McpServer) => unknown

// Identity helper that captures a tool's I/O generics at its call site
// before they are erased into RegisteredTool. Because defineTool itself
// stays generic over <I, O>, passing an object literal here still lets
// TypeScript check `handler`'s return type against
// ToolHandlerReturn<O> — a handler returning the wrong structuredContent
// shape fails to compile here exactly as it would with a direct
// registerToolWithAnnotations call. Do not widen I/O to `unknown` or cast
// around this signature; that would silently defeat the check.
function defineTool<
  // Default {} so an entry omitting inputSchema types its handler args as an
  // empty object, not Record<string, any>.
  I extends z.ZodRawShape = Record<string, never>,
  O extends z.ZodTypeAny | undefined = undefined,
>(entry: {
  name: string
  description?: string
  inputSchema?: I
  outputSchema?: O
  handler: (
    args: { [K in keyof I]: z.infer<I[K]> },
    extra: Parameters<Parameters<McpServer['registerTool']>[2]>[1],
  ) => Promise<ToolHandlerReturn<O>> | ToolHandlerReturn<O>
}): RegisteredTool {
  return (server) =>
    registerToolWithAnnotations(
      server,
      entry.name,
      {
        description: entry.description,
        inputSchema: entry.inputSchema,
        outputSchema: entry.outputSchema,
      },
      entry.handler,
    )
}

// Registers all MCP tools on the given server instance. withDaemon is a
// helper that opens a daemon client for the duration of a single tool call.
export function registerAllTools(
  server: McpServer,
  workspaceId: string,
  withDaemon: <T>(run: (client: ReturnType<typeof createDaemonClient>) => Promise<T>) => Promise<T>,
): void {
  const canvasTool = createCanvasTool()
  const listTool = listCanvasTool()
  const openTool = openCanvasTool()
  const optimizeTool = optimizeCanvasesTool()
  const loadTool = loadImageTool()
  const annotateToolDef = annotateTool()
  const annotateBatchToolDef = annotateBatchTool()
  const exportTool = exportPngTool()
  const exportSvg = exportSvgTool()
  const exportCanvas = exportCanvasTool()
  const viewportTool = viewportSetTool()
  const exportJsonTool = canvasExportJsonTool()
  const autoLayoutTool = canvasAutoLayoutTool()
  const paletteGet = paletteGetTool()
  const paletteSet = paletteSetTool()
  const paletteDelete = paletteDeleteTool()
  const libListTool = libraryListItemsTool()
  const libInsertTool = libraryInsertItemTool()
  const libInsertBatch = libraryInsertBatchTool()
  const libInstall = libraryInstallTool(workspaceId)
  const libUninstall = libraryUninstallTool(workspaceId)
  const libListInstalled = libraryListInstalledTool(workspaceId)
  const libCatalog = libraryCatalogListTool()
  const userLibSave = userLibrarySaveTool()
  const userLibList = userLibraryListTool()
  const userLibRemove = userLibraryRemoveTool()
  const userLibMetadataGet = userLibraryMetadataGetTool()
  const userLibMetadataSet = userLibraryMetadataSetTool()
  const userLibMetadataDelete = userLibraryMetadataDeleteTool()
  const inspectTool = canvasInspectTool()
  const listTemplates = listTemplatesTool()
  const insertTemplate = insertTemplateTool()
  const updateTool = updateElementTool()
  const deleteTool = deleteElementTool()
  const deleteManyTool = deleteElementsTool()
  const assignGroupTool = assignToGroupTool()
  const deleteGroupT = deleteGroupTool()
  const listGroupsT = listGroupsTool()
  const moveTool = moveElementsTool()
  const alignTool = alignElementsTool()
  const distributeTool = distributeElementsTool()
  const reorderTool = reorderElementsTool()
  const clearTool = canvasClearTool()
  const frameCreate = createFrameTool()
  const frameUpdateMembers = updateFrameMembersTool()
  const embedCreate = createEmbedTool()
  const versionSave = versionSaveTool()
  const versionRestore = versionRestoreTool()
  const versionList = versionListTool()
  const pairingLink = pairingLinkTool()

  const tools: RegisteredTool[] = [
    defineTool({
      name: canvasTool.name,
      description: canvasTool.description,
      inputSchema: canvasCreateInputShape,
      outputSchema: canvasCreateOutputSchema,
      handler: async ({ slug, overwrite }) => {
        const result = await withDaemon((client) =>
          canvasTool.execute({ slug, overwrite }, workspaceId, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: listTool.name,
      description: listTool.description,
      inputSchema: canvasListInputShape,
      outputSchema: canvasListOutputSchema,
      handler: async ({ slugContains }) => {
        const result = await withDaemon((client) => listTool.execute({ slugContains }, client))
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: openTool.name,
      description: openTool.description,
      inputSchema: canvasOpenInputShape,
      outputSchema: canvasOpenOutputSchema,
      handler: async ({ id, fullscreen, waitForClient, waitTimeoutMs }) => {
        const result = await withDaemon((client) =>
          openTool.execute({ id, fullscreen, waitForClient, waitTimeoutMs }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: optimizeTool.name,
      description: optimizeTool.description,
      inputSchema: optimizeCanvasesInputShape,
      outputSchema: optimizeCanvasesOutputSchema,
      handler: async ({ slug }) => {
        const result = await withDaemon((client) =>
          optimizeTool.execute({ slug }, workspaceId, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: loadTool.name,
      description: loadTool.description,
      inputSchema: loadImageInputShape,
      outputSchema: loadImageOutputSchema,
      handler: async ({ canvasId, imagePath, position }) => {
        const result = await withDaemon((client) =>
          loadTool.execute({ canvasId, imagePath, position }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: annotateToolDef.name,
      // The Zod raw shape lives in tools/annotate.js (annotateInputShape) so
      // it is the single source of truth shared with the tool's own
      // cross-field validation (annotateInputSchema) — see the comment
      // there for why that extra check cannot live in this raw shape.
      description: annotateToolDef.description,
      inputSchema: annotateInputShape,
      outputSchema: annotateOutputSchema,
      handler: async (args) => {
        const result = await withDaemon((client) => annotateToolDef.execute(args, client))
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: annotateBatchToolDef.name,
      description: annotateBatchToolDef.description,
      inputSchema: annotateBatchInputShape,
      outputSchema: annotateBatchOutputSchema,
      handler: async ({ canvasId, annotations, layout, dryRun, overlapThreshold, groupAs }) => {
        const result = await withDaemon((client) =>
          annotateBatchToolDef.execute(
            { canvasId, annotations, layout, dryRun, overlapThreshold, groupAs },
            client,
          ),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: paletteGet.name,
      description: paletteGet.description,
      inputSchema: paletteGetInputShape,
      outputSchema: paletteOutputSchema,
      handler: async ({ workspaceId }) => {
        const result = await withDaemon((client) => paletteGet.execute({ workspaceId }, client))
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: paletteSet.name,
      description: paletteSet.description,
      inputSchema: paletteSetInputShape,
      outputSchema: paletteOutputSchema,
      handler: async ({ workspaceId, entries }) => {
        const result = await withDaemon((client) =>
          paletteSet.execute({ workspaceId, entries }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: paletteDelete.name,
      description: paletteDelete.description,
      inputSchema: paletteDeleteInputShape,
      outputSchema: paletteOutputSchema,
      handler: async ({ workspaceId, keys }) => {
        const result = await withDaemon((client) =>
          paletteDelete.execute({ workspaceId, keys }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: exportTool.name,
      description: exportTool.description,
      inputSchema: exportPngInputShape,
      outputSchema: exportPngOutputSchema,
      handler: async ({
        canvasId,
        padding,
        scale,
        minFontPx,
        frameId,
        outputPath,
        overwrite,
        theme,
      }) => {
        const result = await withDaemon((client) =>
          exportTool.execute(
            { canvasId, padding, scale, minFontPx, frameId, outputPath, overwrite, theme },
            client,
          ),
        )
        // Return filePath in the text block and attach the image payload as a
        // separate ImageContent block. If reading fails, omit the image block and
        // fall back to returning only filePath.
        const content: Array<
          { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        > = [{ type: 'text', text: JSON.stringify({ filePath: result.filePath }) }]
        if (result.imageBase64) {
          content.push({ type: 'image', data: result.imageBase64, mimeType: 'image/png' })
        }
        return { structuredContent: result, content }
      },
    }),

    defineTool({
      name: viewportTool.name,
      description: viewportTool.description,
      inputSchema: viewportSetInputShape,
      outputSchema: viewportSetOutputSchema,
      handler: async (args) => {
        const result = await withDaemon((client) => viewportTool.execute(args, client))
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: exportJsonTool.name,
      description: exportJsonTool.description,
      inputSchema: canvasExportJsonInputShape,
      outputSchema: canvasExportJsonOutputSchema,
      handler: async ({ canvasId, includeCustomFields, outputPath, overwrite }) => {
        const result = await withDaemon((client) =>
          exportJsonTool.execute({ canvasId, includeCustomFields, outputPath, overwrite }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: exportSvg.name,
      description: exportSvg.description,
      inputSchema: exportSvgInputShape,
      outputSchema: exportSvgOutputSchema,
      handler: async ({ canvasId, padding, frameId, outputPath, overwrite, theme }) => {
        const result = await withDaemon((client) =>
          exportSvg.execute({ canvasId, padding, frameId, outputPath, overwrite, theme }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: exportCanvas.name,
      description: exportCanvas.description,
      inputSchema: exportCanvasInputShape,
      outputSchema: exportCanvasOutputSchema,
      handler: async (args) => {
        const result = await withDaemon((client) => exportCanvas.execute(args, client))
        // PNG results carry an image payload just like export_png's own
        // registration does; svg/json results are text-only structured content.
        const content: Array<
          { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        > = [{ type: 'text', text: JSON.stringify(result) }]
        if (result.format === 'png' && result.imageBase64) {
          content.push({ type: 'image', data: result.imageBase64, mimeType: 'image/png' })
        }
        return { structuredContent: result, content }
      },
    }),

    defineTool({
      name: autoLayoutTool.name,
      description: autoLayoutTool.description,
      inputSchema: canvasAutoLayoutInputShape,
      outputSchema: canvasAutoLayoutOutputSchema,
      handler: async (args) => {
        const result = await withDaemon((client) => autoLayoutTool.execute(args, client))
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: libListTool.name,
      description: libListTool.description,
      inputSchema: libraryListItemsInputShape,
      outputSchema: libraryListItemsOutputSchema,
      handler: async ({ libraryUrl, libraryPath, userLibraryName }) => {
        const result = await withDaemon((client) =>
          libListTool.execute({ libraryUrl, libraryPath, userLibraryName }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: libInsertTool.name,
      description: libInsertTool.description,
      inputSchema: libraryInsertItemInputShape,
      outputSchema: libInsertItemOutputSchema,
      handler: async ({
        canvasId,
        libraryUrl,
        libraryPath,
        userLibraryName,
        itemIndex,
        target,
        scale,
      }) => {
        const result = await withDaemon((client) =>
          libInsertTool.execute(
            { canvasId, libraryUrl, libraryPath, userLibraryName, itemIndex, target, scale },
            client,
          ),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: libInsertBatch.name,
      description: libInsertBatch.description,
      inputSchema: libraryInsertBatchInputShape,
      outputSchema: libraryInsertBatchOutputSchema,
      handler: async ({
        canvasId,
        libraryUrl,
        libraryPath,
        userLibraryName,
        groupAs,
        scale,
        items,
      }) => {
        const result = await withDaemon((client) =>
          libInsertBatch.execute(
            { canvasId, libraryUrl, libraryPath, userLibraryName, groupAs, scale, items },
            client,
          ),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: libInstall.name,
      description: libInstall.description,
      inputSchema: libraryInstallInputShape,
      outputSchema: libraryInstallOutputSchema,
      handler: async ({ libraryUrl }) => {
        const result = await withDaemon((client) => libInstall.execute({ libraryUrl }, client))
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: libUninstall.name,
      description: libUninstall.description,
      inputSchema: libraryUninstallInputShape,
      outputSchema: installedUrlsOutputSchema,
      handler: async ({ libraryUrl }) => {
        const result = await withDaemon((client) => libUninstall.execute({ libraryUrl }, client))
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: libListInstalled.name,
      description: libListInstalled.description,
      inputSchema: libraryListInstalledInputShape,
      outputSchema: installedUrlsOutputSchema,
      handler: async () => {
        const result = await withDaemon((client) => libListInstalled.execute({}, client))
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: libCatalog.name,
      description: libCatalog.description,
      inputSchema: libraryCatalogListInputShape,
      outputSchema: libraryCatalogListOutputSchema,
      handler: async ({ query, limit }) => {
        const result = await libCatalog.execute({ query, limit })
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: userLibSave.name,
      description: userLibSave.description,
      inputSchema: userLibrarySaveInputShape,
      outputSchema: userLibrarySaveOutputSchema,
      handler: async ({ name, fromUrl, content }) => {
        const result = await withDaemon((client) =>
          userLibSave.execute({ name, fromUrl, content }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: userLibList.name,
      description: userLibList.description,
      inputSchema: userLibraryListInputShape,
      outputSchema: userLibraryListOutputSchema,
      handler: async () => {
        const result = await withDaemon((client) => userLibList.execute({}, client))
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: userLibRemove.name,
      description: userLibRemove.description,
      inputSchema: userLibraryRemoveInputShape,
      outputSchema: userLibraryRemoveOutputSchema,
      handler: async ({ name }) => {
        const result = await withDaemon((client) => userLibRemove.execute({ name }, client))
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: userLibMetadataGet.name,
      description: userLibMetadataGet.description,
      inputSchema: userLibraryMetadataGetInputShape,
      outputSchema: userLibraryMetadataManifestSchema,
      handler: async ({ name }) => {
        const result = await withDaemon((client) => userLibMetadataGet.execute({ name }, client))
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: userLibMetadataSet.name,
      description: userLibMetadataSet.description,
      inputSchema: userLibraryMetadataSetInputShape,
      outputSchema: userLibraryMetadataManifestSchema,
      handler: async ({ name, revision, aliases, notes, scales }) => {
        const result = await withDaemon((client) =>
          userLibMetadataSet.execute({ name, revision, aliases, notes, scales }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: userLibMetadataDelete.name,
      description: userLibMetadataDelete.description,
      inputSchema: userLibraryMetadataDeleteInputShape,
      outputSchema: userLibraryMetadataManifestSchema,
      handler: async ({ name, revision, aliasKeys, noteKeys, scaleKeys }) => {
        const result = await withDaemon((client) =>
          userLibMetadataDelete.execute({ name, revision, aliasKeys, noteKeys, scaleKeys }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: inspectTool.name,
      description: inspectTool.description,
      inputSchema: canvasInspectInputShape,
      outputSchema: canvasInspectOutputSchema,
      handler: async ({ canvasId }) => {
        const result = await withDaemon((client) => inspectTool.execute({ canvasId }, client))
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: listTemplates.name,
      description: listTemplates.description,
      inputSchema: listTemplatesInputShape,
      outputSchema: templateListOutputSchema,
      handler: async () => {
        const result = await listTemplates.execute()
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: insertTemplate.name,
      description: insertTemplate.description,
      inputSchema: insertTemplateInputShape,
      outputSchema: templateInsertOutputSchema,
      handler: async ({ canvasId, templateId, templatePath, target, scale, variables }) => {
        const result = await withDaemon((client) =>
          insertTemplate.execute(
            { canvasId, templateId, templatePath, target, scale, variables },
            client,
          ),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: updateTool.name,
      description: updateTool.description,
      inputSchema: updateElementInputShape,
      outputSchema: elementIdOutputSchema,
      handler: async ({ canvasId, elementId, patch }) => {
        const result = await withDaemon((client) =>
          updateTool.execute({ canvasId, elementId, patch }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: deleteTool.name,
      description: deleteTool.description,
      inputSchema: deleteElementInputShape,
      outputSchema: elementIdOutputSchema,
      handler: async ({ canvasId, elementId }) => {
        const result = await withDaemon((client) =>
          deleteTool.execute({ canvasId, elementId }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: deleteManyTool.name,
      description: deleteManyTool.description,
      inputSchema: deleteElementsInputShape,
      outputSchema: deletedElementsOutputSchema,
      handler: async ({ canvasId, elementIds }) => {
        const result = await withDaemon((client) =>
          deleteManyTool.execute({ canvasId, elementIds }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: assignGroupTool.name,
      description: assignGroupTool.description,
      inputSchema: assignToGroupInputShape,
      outputSchema: assignGroupOutputSchema,
      handler: async ({ canvasId, groupId, elementIds }) => {
        const result = await withDaemon((client) =>
          assignGroupTool.execute({ canvasId, groupId, elementIds }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: deleteGroupT.name,
      description: deleteGroupT.description,
      inputSchema: deleteGroupInputShape,
      outputSchema: deletedElementsOutputSchema,
      handler: async ({ canvasId, groupId }) => {
        const result = await withDaemon((client) =>
          deleteGroupT.execute({ canvasId, groupId }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: listGroupsT.name,
      description: listGroupsT.description,
      inputSchema: listGroupsInputShape,
      outputSchema: listGroupsOutputSchema,
      handler: async ({ canvasId }) => {
        const result = await withDaemon((client) => listGroupsT.execute({ canvasId }, client))
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: moveTool.name,
      description: moveTool.description,
      inputSchema: moveElementsInputShape,
      outputSchema: elementIdsOutputSchema,
      handler: async ({ canvasId, elementIds, dx, dy }) => {
        const result = await withDaemon((client) =>
          moveTool.execute({ canvasId, elementIds, dx, dy }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: alignTool.name,
      description: alignTool.description,
      // Input + output schemas come from element-ops-tools.ts as the single
      // source of truth — execute()'s arg type is z.infer<typeof
      // alignInputSchema> there, so registration and runtime stay in sync.
      inputSchema: alignInputSchema.shape,
      outputSchema: alignOutputSchema,
      handler: async ({ canvasId, elementIds, alignment }) => {
        const result = await withDaemon((client) =>
          alignTool.execute({ canvasId, elementIds, alignment }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: distributeTool.name,
      description: distributeTool.description,
      inputSchema: distributeInputSchema.shape,
      outputSchema: distributeOutputSchema,
      handler: async ({ canvasId, elementIds, direction }) => {
        const result = await withDaemon((client) =>
          distributeTool.execute({ canvasId, elementIds, direction }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: reorderTool.name,
      description: reorderTool.description,
      inputSchema: reorderElementsInputShape,
      outputSchema: reorderOutputSchema,
      handler: async ({ canvasId, elementIds, action }) => {
        const result = await withDaemon((client) =>
          reorderTool.execute({ canvasId, elementIds, action }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: clearTool.name,
      description: clearTool.description,
      inputSchema: canvasClearInputShape,
      outputSchema: clearedCountOutputSchema,
      handler: async ({ canvasId }) => {
        const result = await withDaemon((client) => clearTool.execute({ canvasId }, client))
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: versionSave.name,
      description: versionSave.description,
      inputSchema: versionSaveInputShape,
      outputSchema: versionSaveOutputSchema,
      handler: async ({ canvasId, label }) => {
        const result = await withDaemon((client) =>
          versionSave.execute({ canvasId, label }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: versionRestore.name,
      description: versionRestore.description,
      inputSchema: versionRestoreInputShape,
      outputSchema: versionRestoreOutputSchema,
      handler: async ({ canvasId, versionId, targetSlug, overwrite }) => {
        const result = await withDaemon((client) =>
          versionRestore.execute({ canvasId, versionId, targetSlug, overwrite }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: versionList.name,
      description: versionList.description,
      inputSchema: versionListInputShape,
      outputSchema: versionListOutputSchema,
      handler: async ({ canvasId }) => {
        const result = await withDaemon((client) => versionList.execute({ canvasId }, client))
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: frameCreate.name,
      description: frameCreate.description,
      inputSchema: createFrameInputShape,
      outputSchema: createFrameOutputSchema,
      handler: async ({ canvasId, x, y, width, height, name, memberIds, padding }) => {
        const result = await withDaemon((client) =>
          frameCreate.execute({ canvasId, x, y, width, height, name, memberIds, padding }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: frameUpdateMembers.name,
      description: frameUpdateMembers.description,
      inputSchema: updateFrameMembersInputShape,
      outputSchema: updateFrameMembersOutputSchema,
      handler: async ({ canvasId, frameId, add, remove, padding }) => {
        const result = await withDaemon((client) =>
          frameUpdateMembers.execute({ canvasId, frameId, add, remove, padding }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: embedCreate.name,
      description: embedCreate.description,
      inputSchema: createEmbedInputShape,
      outputSchema: createEmbedOutputSchema,
      handler: async ({ canvasId, url, x, y, width, height }) => {
        const result = await withDaemon((client) =>
          embedCreate.execute({ canvasId, url, x, y, width, height }, client),
        )
        return structuredJsonResult(result)
      },
    }),

    defineTool({
      name: pairingLink.name,
      description: pairingLink.description,
      inputSchema: createPairingLinkInputShape,
      outputSchema: createPairingLinkOutputSchema,
      handler: async (args) => {
        const result = await withDaemon((client) => pairingLink.execute(args, client))
        // content[0] stays JSON (the structuredJsonResult convention every other
        // tool follows, and what callers/smoke parse as the primary payload); the
        // credential note travels as a second text block instead of overwriting it.
        return {
          structuredContent: result,
          content: [
            { type: 'text' as const, text: JSON.stringify(result) },
            { type: 'text' as const, text: buildPairingLinkText(result, result.webOrigin) },
          ],
        }
      },
    }),
  ]

  for (const register of tools) {
    register(server)
  }
}
