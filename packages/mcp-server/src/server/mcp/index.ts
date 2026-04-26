#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { DATA_DIR } from '../config.js'
import { ensureDaemon } from '../../daemon/ensure-daemon.js'
import { createDaemonClient } from './daemon-client.js'
import {
  canvasCreateOutputSchema,
  canvasListOutputSchema,
  canvasOpenOutputSchema,
  createCanvasTool,
  listCanvasTool,
  openCanvasTool,
} from './tools/canvas.js'
import { loadImageOutputSchema, loadImageTool } from './tools/load.js'
import { annotateOutputSchema, annotateTool } from './tools/annotate.js'
import { annotateBatchOutputSchema, annotateBatchTool } from './tools/annotate-batch.js'
import { exportPngOutputSchema, exportPngTool } from './tools/export.js'
import { viewportSetOutputSchema, viewportSetTool } from './tools/viewport.js'
import { canvasExportJsonOutputSchema, canvasExportJsonTool } from './tools/canvas-export-json.js'
import { canvasAutoLayoutOutputSchema, canvasAutoLayoutTool } from './tools/canvas-auto-layout.js'
import {
  paletteDeleteTool,
  paletteGetTool,
  paletteOutputSchema,
  paletteSetTool,
} from './tools/palette.js'
import {
  installedUrlsOutputSchema,
  libInsertItemOutputSchema,
  libraryInsertBatchOutputSchema,
  libraryInsertBatchTool,
  libraryInsertItemTool,
  libraryInstallOutputSchema,
  libraryInstallTool,
  libraryListInstalledTool,
  libraryListItemsOutputSchema,
  libraryListItemsTool,
  libraryUninstallTool,
  userLibraryListOutputSchema,
  userLibraryListTool,
  userLibraryMetadataDeleteTool,
  userLibraryMetadataGetTool,
  userLibraryMetadataManifestSchema,
  userLibraryMetadataSetTool,
  userLibraryRemoveOutputSchema,
  userLibraryRemoveTool,
  userLibrarySaveOutputSchema,
  userLibrarySaveTool,
} from './tools/library.js'
import { libraryCatalogListOutputSchema, libraryCatalogListTool } from './tools/library-catalog.js'
import { canvasInspectOutputSchema, canvasInspectTool } from './tools/canvas-inspect.js'
import {
  insertTemplateTool,
  listTemplatesTool,
  templateInsertOutputSchema,
  templateListOutputSchema,
} from './tools/template.js'
import {
  assignGroupOutputSchema,
  assignToGroupTool,
  canvasClearTool,
  clearedCountOutputSchema,
  deletedElementsOutputSchema,
  deleteElementTool,
  deleteElementsTool,
  deleteGroupTool,
  elementIdOutputSchema,
  elementIdsOutputSchema,
  listGroupsOutputSchema,
  listGroupsTool,
  moveElementsTool,
  reorderElementsTool,
  reorderOutputSchema,
  updateElementTool,
} from './tools/element-ops-tools.js'
import {
  checkpointRestoreOutputSchema,
  checkpointRestoreTool,
  checkpointSaveOutputSchema,
  checkpointSaveTool,
} from './tools/checkpoint.js'
import {
  createEmbedOutputSchema,
  createEmbedTool,
  createFrameOutputSchema,
  createFrameTool,
  updateFrameMembersOutputSchema,
  updateFrameMembersTool,
} from './tools/frame-embed.js'
import { ensureWorkspaceId } from './session-resolver.js'
import { PACKAGE_VERSION } from '../../shared/package-version.js'
import { isDirectEntryPoint } from '../entrypoint.js'
import {
  buildDrawDiagramPrompt,
  formatInstalledLibrariesResource,
  formatRecentCanvasesResource,
  getStandaloneHelpText,
  WHITEBOARD_DRAW_PROMPT,
  WHITEBOARD_HELP_URI,
  WHITEBOARD_INSTALLED_LIBRARIES_URI,
  WHITEBOARD_RECENT_CANVASES_URI,
} from './standalone-help.js'

function structuredJsonResult<T extends object>(result: T) {
  const structuredContent = result as T & { [key: string]: unknown }
  return {
    structuredContent,
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
  }
}

// Binds a registered tool's handler return shape to its declared outputSchema.
// When outputSchema is given, the handler must hand structuredContent whose
// shape matches z.infer<O>; drift becomes a compile error instead of a
// runtime "Output validation error" reaching MCP clients.
type ToolHandlerReturn<O extends z.ZodTypeAny | undefined> = O extends z.ZodTypeAny
  ?
      | {
          structuredContent: z.infer<O>
          content: ReadonlyArray<{ type: 'text'; text: string } | Record<string, unknown>>
          isError?: false
        }
      | {
          isError: true
          content: ReadonlyArray<{ type: 'text'; text: string } | Record<string, unknown>>
        }
  :
      | {
          content: ReadonlyArray<{ type: 'text'; text: string } | Record<string, unknown>>
          structuredContent?: unknown
          isError?: boolean
        }

// MCP tool annotations profile.
// MCP spec: https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations
// Clients (Claude Code / Codex) use read-only / destructive flags for approval
// UI and auto-run policy decisions.
// openWorldHint: false means the tool operates only on local canvas state.
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const
const DESTRUCTIVE_IDEMPOTENT = {
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const
const MUTATING_IDEMPOTENT = { idempotentHint: true, openWorldHint: false } as const
const MUTATING = { openWorldHint: false } as const

// Tools that fetch external URLs declare openWorldHint: true.
const READ_ONLY_EXTERNAL = { readOnlyHint: true, openWorldHint: true } as const
const MUTATING_EXTERNAL = { openWorldHint: true } as const

// Map from tool name to annotation profile and human-friendly title. Used by
// registerToolWithAnnotations when building McpServer annotations.
type AnnotationProfile = Readonly<Record<string, boolean>>
const TOOL_PROFILES: Record<string, { profile: AnnotationProfile; title: string }> = {
  // Read-only (local)
  canvas_list: { profile: READ_ONLY, title: 'List canvases' },
  canvas_open: { profile: READ_ONLY, title: 'Open canvas in browser' },
  canvas_inspect: { profile: READ_ONLY, title: 'Inspect canvas elements' },
  canvas_export_json: { profile: READ_ONLY, title: 'Export canvas as JSON' },
  export_png: { profile: READ_ONLY, title: 'Export canvas as PNG' },
  list_groups: { profile: READ_ONLY, title: 'List element groups' },
  template_list: { profile: READ_ONLY, title: 'List built-in templates' },
  palette_get: { profile: READ_ONLY, title: 'Get palette entries' },
  user_library_list: { profile: READ_ONLY, title: 'List user libraries' },
  user_library_metadata_get: { profile: READ_ONLY, title: 'Get user library metadata' },
  library_list_items: { profile: READ_ONLY, title: 'List library items' },
  library_list_installed: { profile: READ_ONLY, title: 'List installed libraries' },

  // Read-only (external fetch)
  library_catalog_list: { profile: READ_ONLY_EXTERNAL, title: 'Search official library catalog' },

  // Destructive + idempotent (safe to rerun; tombstone/delete)
  canvas_clear: { profile: DESTRUCTIVE_IDEMPOTENT, title: 'Clear canvas (delete all elements)' },
  delete_element: { profile: DESTRUCTIVE_IDEMPOTENT, title: 'Delete element' },
  delete_elements: { profile: DESTRUCTIVE_IDEMPOTENT, title: 'Delete multiple elements' },
  delete_group: { profile: DESTRUCTIVE_IDEMPOTENT, title: 'Delete element group' },
  palette_delete: { profile: DESTRUCTIVE_IDEMPOTENT, title: 'Delete palette entries' },
  library_uninstall: { profile: DESTRUCTIVE_IDEMPOTENT, title: 'Uninstall library' },
  user_library_remove: { profile: DESTRUCTIVE_IDEMPOTENT, title: 'Remove user library' },
  user_library_metadata_delete: {
    profile: DESTRUCTIVE_IDEMPOTENT,
    title: 'Delete user library metadata fields',
  },

  // Mutating + idempotent (safe to rerun with the same arguments)
  update_element: { profile: MUTATING_IDEMPOTENT, title: 'Update element fields' },
  move_elements: { profile: MUTATING_IDEMPOTENT, title: 'Move elements (relative dx/dy)' },
  reorder_elements: { profile: MUTATING_IDEMPOTENT, title: 'Reorder elements (front/back)' },
  viewport_set: { profile: MUTATING_IDEMPOTENT, title: 'Set browser viewport' },
  palette_set: { profile: MUTATING_IDEMPOTENT, title: 'Set palette entries' },
  user_library_metadata_set: { profile: MUTATING_IDEMPOTENT, title: 'Set user library metadata' },
  assign_to_group: { profile: MUTATING_IDEMPOTENT, title: 'Assign elements to group' },
  update_frame_members: { profile: MUTATING_IDEMPOTENT, title: 'Update frame members' },

  // Mutating non-idempotent (side effects / new IDs / state changes)
  canvas_create: { profile: MUTATING, title: 'Create canvas' },
  annotate: { profile: MUTATING, title: 'Add annotation element' },
  annotate_batch: { profile: MUTATING, title: 'Add multiple annotation elements' },
  load_image: { profile: MUTATING, title: 'Load image into canvas' },
  canvas_auto_layout: { profile: MUTATING, title: 'Auto-layout canvas (DAG)' },
  template_insert: { profile: MUTATING, title: 'Insert template parts' },
  checkpoint_save: { profile: MUTATING, title: 'Save canvas checkpoint' },
  checkpoint_restore: { profile: MUTATING, title: 'Restore canvas from checkpoint' },
  create_frame: { profile: MUTATING, title: 'Create frame container' },
  create_embed: { profile: MUTATING, title: 'Embed external URL into canvas' },
  library_insert_item: { profile: MUTATING, title: 'Insert library item' },
  library_insert_batch: { profile: MUTATING, title: 'Insert multiple library items' },
  user_library_save: { profile: MUTATING, title: 'Save user library' },

  // Mutating + external (fetches over HTTPS and writes daemon state)
  library_install: { profile: MUTATING_EXTERNAL, title: 'Install library from HTTPS URL' },
}

// Thin wrapper around McpServer.registerTool that injects annotations. Keeping
// inputSchema generic preserves handler argument inference. outputSchema stays
// unknown because the SDK accepts multiple overload shapes.
//
// It also converts handler throws into MCP `{ isError: true, content: [...] }`
// responses. The MCP spec recommends tool errors use isError responses rather
// than JSON-RPC errors so the LLM can react on the next call.
function registerToolWithAnnotations<
  I extends z.ZodRawShape,
  O extends z.ZodTypeAny | undefined = undefined,
>(
  server: McpServer,
  name: string,
  config: {
    description?: string
    inputSchema?: I
    outputSchema?: O
  },
  handler: (
    args: { [K in keyof I]: z.infer<I[K]> },
    extra: Parameters<Parameters<McpServer['registerTool']>[2]>[1],
  ) => Promise<ToolHandlerReturn<O>> | ToolHandlerReturn<O>,
): unknown {
  const profile = TOOL_PROFILES[name]
  if (!profile) {
    // Fall back conservatively to MUTATING and emit a warning so it is noticed.
    console.warn(`[mcp] tool "${name}" has no annotations profile; defaulting to MUTATING`)
  }
  const annotations = profile
    ? { ...profile.profile, title: profile.title }
    : { ...MUTATING, title: name }
  // Wrap the handler so thrown errors become isError responses.
  const wrappedHandler = async (
    args: { [K in keyof I]: z.infer<I[K]> },
    extra: Parameters<typeof handler>[1],
  ): Promise<unknown> => {
    try {
      return await handler(args, extra)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        isError: true,
        content: [{ type: 'text' as const, text: message }],
      }
    }
  }
  return (server.registerTool as unknown as (
    n: string,
    c: object,
    h: typeof wrappedHandler,
  ) => unknown)(name, { ...config, annotations }, wrappedHandler)
}

export async function createExcalidrawMcpServer() {
  // ensureWorkspaceId memoizes the resolve+save sequence per DATA_DIR so the
  // HTTP /mcp handler does not race concurrent requests on the marker file.
  const workspaceId = await ensureWorkspaceId(DATA_DIR)

  // Read `version` from package.json at runtime so release-please bumps propagate
  // without source edits.
  const server = new McpServer({
    name: 'whiteboard',
    version: PACKAGE_VERSION,
  })

  server.registerResource(
    'whiteboard-help',
    WHITEBOARD_HELP_URI,
    {
      title: 'Whiteboard MCP quickstart',
      description: 'Standalone help for raw MCP clients that do not load Claude/Codex skills.',
      mimeType: 'text/markdown',
    },
    async () => ({
      contents: [
        {
          uri: WHITEBOARD_HELP_URI,
          mimeType: 'text/markdown',
          text: getStandaloneHelpText(),
        },
      ],
    }),
  )

  server.registerPrompt(
    WHITEBOARD_DRAW_PROMPT,
    {
      title: 'Draw Diagram',
      description: 'Generate a starter prompt for drawing a new diagram with the whiteboard tools.',
      argsSchema: {
        goal: z.string().describe('What the diagram should explain or align on.'),
        diagramType: z
          .string()
          .optional()
          .describe('Optional diagram type hint such as architecture, sequence, review, or comparison.'),
      },
    },
    async ({ goal, diagramType }) => ({
      description: 'Starter instructions for creating a new whiteboard diagram.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: buildDrawDiagramPrompt(goal, diagramType),
          },
        },
      ],
    }),
  )

  // Tool registration.
  const canvasTool = createCanvasTool()
  const listTool = listCanvasTool()
  const openTool = openCanvasTool()
  const loadTool = loadImageTool()
  const annotateToolDef = annotateTool()
  const annotateBatchToolDef = annotateBatchTool()
  const exportTool = exportPngTool()
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
  const reorderTool = reorderElementsTool()
  const clearTool = canvasClearTool()
  const checkpointSave = checkpointSaveTool()
  const checkpointRestore = checkpointRestoreTool()
  const frameCreate = createFrameTool()
  const frameUpdateMembers = updateFrameMembersTool()
  const embedCreate = createEmbedTool()

  const withDaemon = async <T>(run: (client: ReturnType<typeof createDaemonClient>) => Promise<T>): Promise<T> => {
    const daemon = await ensureDaemon()
    const client = createDaemonClient(daemon)
    await client.touch()
    return run(client)
  }

  server.registerResource(
    'whiteboard-installed-libraries',
    WHITEBOARD_INSTALLED_LIBRARIES_URI,
    {
      title: 'Installed libraries',
      description: 'Dynamic summary of library URLs installed in the current workspace.',
      mimeType: 'text/markdown',
    },
    async () => {
      const libraries = await withDaemon((client) => libListInstalled.execute({}, client))
      return {
        contents: [
          {
            uri: WHITEBOARD_INSTALLED_LIBRARIES_URI,
            mimeType: 'text/markdown',
            text: formatInstalledLibrariesResource(libraries.installedUrls),
          },
        ],
      }
    },
  )

  server.registerResource(
    'whiteboard-recent-canvases',
    WHITEBOARD_RECENT_CANVASES_URI,
    {
      title: 'Recent canvases',
      description: 'Dynamic summary of recently updated canvases across known workspaces.',
      mimeType: 'text/markdown',
    },
    async () => {
      const canvases = await withDaemon((client) => listTool.execute({}, client))
      return {
        contents: [
          {
            uri: WHITEBOARD_RECENT_CANVASES_URI,
            mimeType: 'text/markdown',
            text: formatRecentCanvasesResource(canvases.workspaces),
          },
        ],
      }
    },
  )

  registerToolWithAnnotations(server,
    canvasTool.name,
    {
      description: canvasTool.description,
      inputSchema: {
        slug: z.string().describe(
          'URL-safe canvas slug (a-z, 0-9, hyphen). Used as the canvas identifier within the current workspace. Returned canvasId is "{workspaceId}/{slug}".',
        ),
        issueNumber: z.number().optional().describe(
          'Optional GitHub issue number prefix. When set, the final slug becomes "{issueNumber}-{slug}" (e.g. issueNumber=42 + slug=login → "42-login").',
        ),
        overwrite: z.boolean().optional().describe(
          'When true, replace an existing canvas with the same slug. Default false — existing slug throws ConflictError.',
        ),
      },
      outputSchema: canvasCreateOutputSchema,
    },
    async ({ slug, issueNumber, overwrite }) => {
      const result = await withDaemon((client) =>
        canvasTool.execute({ slug, issueNumber, overwrite }, workspaceId, client),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    listTool.name,
    {
      description: listTool.description,
      inputSchema: {
        activeOnly: z.boolean().optional().describe(
          'When true, only return workspaces whose local Excalidraw daemon is currently alive (port + PID liveness). Default false (returns all workspaces including dead ones).',
        ),
        slugContains: z.string().optional().describe(
          'Case-insensitive substring filter on canvas slug. Workspaces with 0 matching canvases are omitted from the output to reduce noise.',
        ),
      },
      outputSchema: canvasListOutputSchema,
    },
    async ({ activeOnly, slugContains }) => {
      const result = await withDaemon((client) => listTool.execute({ activeOnly, slugContains }, client))
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    openTool.name,
    {
      description: openTool.description,
      inputSchema: {
        id: z.string().describe(
          'Canvas ID in "{workspaceId}/{slug}" form (returned by canvas_create / canvas_list).',
        ),
        fullscreen: z.boolean().optional().describe(
          'Open in fullscreen editing mode (sidebar hidden, Excalidraw fills viewport). User can toggle with sidebar button or "f" / Escape. Default false.',
        ),
        waitForClient: z.boolean().optional().describe(
          'Block until the browser establishes a WebSocket connection. Prevents no_client errors when chaining canvas_open → export_png / viewport_set. Default false.',
        ),
        waitTimeoutMs: z.number().optional().describe(
          'Polling timeout (ms) for waitForClient. Default 5000. Ignored when waitForClient is false.',
        ),
      },
      outputSchema: canvasOpenOutputSchema,
    },
    async ({ id, fullscreen, waitForClient, waitTimeoutMs }) => {
      const result = await withDaemon((client) =>
        openTool.execute({ id, fullscreen, waitForClient, waitTimeoutMs }, client),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    loadTool.name,
    {
      description: loadTool.description,
      inputSchema: {
        canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
        imagePath: z.string().describe(
          'Absolute path to a local image file (PNG / JPEG / GIF / WEBP / SVG). Image is uploaded to the canvas file store and inserted as an Excalidraw image element.',
        ),
        position: z.enum(['center', 'left', 'right']).optional().describe(
          'Where to place the image relative to the existing canvas content. Default "center".',
        ),
      },
      outputSchema: loadImageOutputSchema,
    },
    async ({ canvasId, imagePath, position }) => {
      const result = await withDaemon((client) =>
        loadTool.execute({ canvasId, imagePath, position }, client),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    annotateToolDef.name,
    {
      description: annotateToolDef.description,
      inputSchema: {
        canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
        type: z.enum(['arrow', 'text', 'rectangle', 'highlight', 'box_with_label', 'group']).describe(
          'Annotation kind. arrow = directed arrow, text = standalone label, rectangle = empty box, highlight = filled background, box_with_label = box + auto-wrapped title/subText, group = bbox+title around existing memberIds.',
        ),
        imageId: z.string().optional().describe(
          'When set, target/endTarget are interpreted relative to the named image (use load_image first). Use with coords="relative".',
        ),
        coords: z.enum(['absolute', 'relative', 'parent']).optional().describe(
          'Coordinate space. "absolute" (default) = world coords. "relative" = offset from imageId. "parent" = offset from a parent element (defer-resolved at apply-time, used for sticky annotations on moving parents).',
        ),
        target: z.object({ x: z.number(), y: z.number() }).describe(
          'Top-left corner of the element in chosen coord space. For arrows this is the start point.',
        ),
        text: z.union([z.string(), z.array(z.string())]).optional().describe(
          'Body text. string[] for explicit line breaks; long lines auto-wrap to box width when autoFit=true.',
        ),
        title: z.union([z.string(), z.array(z.string())]).optional().describe(
          'Header text rendered larger than text. Used by box_with_label to separate title from body.',
        ),
        subText: z.union([z.string(), z.array(z.string())]).optional().describe(
          'Smaller secondary text. Default position is below the box (inside-bottom). Use subTextPosition="top" for above-box captions.',
        ),
        subTextPosition: z.enum(['top', 'inside-bottom']).optional().describe(
          'Where subText is placed relative to box_with_label. Default "inside-bottom".',
        ),
        autoFit: z.boolean().optional().describe(
          'Auto-wrap long lines and auto-grow box height. Default true. Set false to honor explicit string[] line breaks strictly.',
        ),
        color: z.string().optional().describe(
          'Stroke / text color. Accepts semantic keys ("primary","success","danger","warning","neutral","info") or palette key (declared via palette_set) or hex (#RRGGBB).',
        ),
        backgroundColor: z.string().optional().describe(
          'Fill color (rectangle / highlight / box_with_label background). Same key vocabulary as `color`.',
        ),
        fillStyle: z.enum(['solid', 'hachure', 'cross-hatch']).optional().describe(
          'Fill pattern for box / highlight. Default Excalidraw default ("hachure").',
        ),
        strokeWidth: z.number().optional().describe('Line thickness in px. Default 2.'),
        fontFamily: z
          .union([
            z.literal(1),
            z.literal(2),
            z.literal(3),
            z.literal(5),
            z.literal(6),
            z.literal(7),
            z.literal(8),
            z.literal(9),
          ])
          .optional()
          .describe(
            'Excalidraw font family enum (1=Virgil/hand-drawn, 2=Helvetica, 3=Cascadia/mono, 5-9 = additional families). Default 1.',
          ),
        fontSize: z.number().optional().describe('Text size in px. Default 20.'),
        width: z.number().optional().describe(
          'Box width in px (rectangle / highlight / box_with_label). Required for accurate text wrap.',
        ),
        height: z.number().optional().describe(
          'Box height in px. With autoFit=true, used as a minimum (grows if text overflows).',
        ),
        align: z.enum(['left', 'center', 'right']).optional().describe(
          'Horizontal text alignment inside box_with_label / text. Default "left".',
        ),
        endTarget: z.object({ x: z.number(), y: z.number() }).optional().describe(
          'Arrow end point. Required when type="arrow" and endBoxId is not set.',
        ),
        startBoxId: z.string().optional().describe(
          'Arrow start: snap to the named box edge instead of using `target`. Convenient for connecting existing elements.',
        ),
        endBoxId: z.string().optional().describe(
          'Arrow end: snap to the named box edge instead of using `endTarget`.',
        ),
        label: z.string().optional().describe('Inline label rendered along the arrow midpoint.'),
        labelOffset: z.number().optional().describe(
          'Perpendicular offset (px) from arrow path for the label. Default 8.',
        ),
        labelSide: z.enum(['auto', 'above', 'below', 'left', 'right']).optional().describe(
          'Side of arrow path where label sits. "auto" picks the less-crowded side. Default "auto".',
        ),
        memberIds: z.array(z.string()).optional().describe(
          'For type="group": ids of existing elements to wrap with a labeled bbox.',
        ),
        padding: z.number().optional().describe(
          'For type="group": extra padding (px) around the member bbox. Default 16.',
        ),
      },
      outputSchema: annotateOutputSchema,
    },
    async ({ canvasId, type, imageId, coords, target, text, title, subText, subTextPosition, autoFit, color, backgroundColor, fillStyle, strokeWidth, fontFamily, fontSize, width, height, align, endTarget, startBoxId, endBoxId, label, labelOffset, labelSide, memberIds, padding }) => {
      const result = await withDaemon((client) =>
        annotateToolDef.execute(
          { canvasId, type, imageId, coords, target, text, title, subText, subTextPosition, autoFit, color, backgroundColor, fillStyle, strokeWidth, fontFamily, fontSize, width, height, align, endTarget, startBoxId, endBoxId, label, labelOffset, labelSide, memberIds, padding },
          client,
        ),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    annotateBatchToolDef.name,
    {
      description: annotateBatchToolDef.description,
      inputSchema: {
        canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
        layout: z
          .object({
            cols: z.number().describe('Number of grid columns.'),
            rows: z.number().describe('Number of grid rows.'),
            cellW: z.number().optional().describe(
              'Default cell width (px). Used when colWidths is not specified.',
            ),
            cellH: z.number().optional().describe(
              'Default cell height (px). Used when rowHeights is not specified.',
            ),
            colWidths: z.array(z.number()).optional().describe(
              'Per-column widths (px). Length must match cols. Use for unequal column widths in comparison matrices.',
            ),
            rowHeights: z.array(z.number()).optional().describe(
              'Per-row heights (px). Length must match rows.',
            ),
            gap: z.number().describe('Gap between cells (px).'),
            origin: z.object({ x: z.number(), y: z.number() }).describe(
              'Top-left corner of the grid in world coords.',
            ),
          })
          .optional()
          .describe(
            'Optional grid layout. When set, items use row/col/rowSpan/colSpan to position. When omitted, items use absolute target coords. Avoid mixing layout with banner/footer extras (use absolute coords for those).',
          ),
        dryRun: z.boolean().optional().describe(
          'When true, return placements + warnings without committing to canvas. Use to preview overlaps before applying. Default false.',
        ),
        overlapThreshold: z.number().optional().describe(
          'IoU threshold (0..1) above which placements are flagged as overlapping in warnings. Default 0.05.',
        ),
        groupAs: z.string().optional().describe(
          'Optional batch-level group label applied to all created elements. Per-item annotations[].groupAs overrides.',
        ),
        annotations: z
          .array(
            z.object({
              type: z.enum(['arrow', 'text', 'rectangle', 'highlight', 'box_with_label', 'group']).describe(
                'Annotation kind. Same vocabulary as annotate tool.',
              ),
              imageId: z.string().optional(),
              coords: z.enum(['absolute', 'relative']).optional().describe(
                'Coord space. With grid layout, ignored (row/col is used). Default "absolute".',
              ),
              target: z.object({ x: z.number(), y: z.number() }).optional().describe(
                'Absolute / relative position when not using grid layout.',
              ),
              row: z.number().optional().describe(
                'Grid row index (0-based). Required when layout is set.',
              ),
              col: z.number().optional().describe(
                'Grid column index (0-based). Required when layout is set.',
              ),
              rowSpan: z.number().optional().describe(
                'Number of rows this cell spans. Default 1.',
              ),
              colSpan: z.number().optional().describe(
                'Number of columns this cell spans. Default 1.',
              ),
              text: z.union([z.string(), z.array(z.string())]).optional(),
              title: z.union([z.string(), z.array(z.string())]).optional(),
              subText: z.union([z.string(), z.array(z.string())]).optional(),
              subTextPosition: z.enum(['top', 'inside-bottom']).optional(),
              autoFit: z.boolean().optional(),
              color: z.string().optional(),
              backgroundColor: z.string().optional(),
              fillStyle: z.enum(['solid', 'hachure', 'cross-hatch']).optional(),
              strokeWidth: z.number().optional(),
              fontFamily: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(6), z.literal(7), z.literal(8), z.literal(9)]).optional(),
              fontSize: z.number().optional(),
              width: z.number().optional(),
              height: z.number().optional(),
              align: z.enum(['left', 'center', 'right']).optional(),
              endTarget: z.object({ x: z.number(), y: z.number() }).optional(),
              startBoxId: z.string().optional(),
              endBoxId: z.string().optional(),
              label: z.string().optional(),
              labelOffset: z.number().optional(),
              labelSide: z.enum(['auto', 'above', 'below', 'left', 'right']).optional(),
              memberIds: z.array(z.string()).optional(),
              padding: z.number().optional(),
              name: z.string().optional().describe(
                'Logical name for this item within the batch (referenced by other items as startBoxName / endBoxName). Required for cross-item arrow snap.',
              ),
              startBoxName: z.string().optional().describe(
                'Refer to a sibling item by its `name` to snap arrow start to that box edge.',
              ),
              endBoxName: z.string().optional().describe(
                'Same as startBoxName but for arrow end.',
              ),
            }),
          )
          .min(1)
          .describe(
            'Annotation items in this batch. Created in 1 snapshot/commit/broadcast. Each item has the same fields as `annotate` plus row/col/rowSpan/colSpan for grid layout and name/startBoxName/endBoxName for cross-item snap.',
          ),
      },
      outputSchema: annotateBatchOutputSchema,
    },
    async ({ canvasId, annotations, layout, dryRun, overlapThreshold, groupAs }) => {
      const result = await withDaemon((client) =>
        annotateBatchToolDef.execute({ canvasId, annotations, layout, dryRun, overlapThreshold, groupAs }, client),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    paletteGet.name,
    {
      description: paletteGet.description,
      inputSchema: { workspaceId: z.string() },
      outputSchema: paletteOutputSchema,
    },
    async ({ workspaceId }) => {
      const result = await withDaemon((client) => paletteGet.execute({ workspaceId }, client))
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    paletteSet.name,
    {
      description: paletteSet.description,
      inputSchema: {
        workspaceId: z.string().describe(
          'Workspace ID (the part before "/" in canvasId). Palette is shared across all canvases in the workspace.',
        ),
        entries: z.record(z.string(), z.string()).describe(
          'Color key → hex map. Keys are dotted semantic identifiers (e.g. "plan.a.bg", "accent.target"). Values are hex (#RRGGBB). Existing keys are merged (not replaced wholesale). Use these keys instead of hex in annotate/annotate_batch color/backgroundColor for re-themability.',
        ),
      },
      outputSchema: paletteOutputSchema,
    },
    async ({ workspaceId, entries }) => {
      const result = await withDaemon((client) => paletteSet.execute({ workspaceId, entries }, client))
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    paletteDelete.name,
    {
      description: paletteDelete.description,
      inputSchema: { workspaceId: z.string(), keys: z.array(z.string()).min(1) },
      outputSchema: paletteOutputSchema,
    },
    async ({ workspaceId, keys }) => {
      const result = await withDaemon((client) => paletteDelete.execute({ workspaceId, keys }, client))
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    exportTool.name,
    {
      description: exportTool.description,
      inputSchema: {
        canvasId: z.string().describe(
          'Canvas ID in "{workspaceId}/{slug}" form. Browser must be connected (call canvas_open first).',
        ),
        padding: z.number().optional().describe(
          'Padding (px) around all elements in the exported PNG. Default 10. Use 24-48 to avoid cropping annotation strokes / text.',
        ),
        scale: z.number().optional().describe(
          'Export scale factor (appState.exportScale). Default 1. Use 2-3 for high-DPI exports of large canvases.',
        ),
        minFontPx: z.number().optional().describe(
          'Minimum font size (px) enforced on text elements before export. Clones with Math.max(fontSize, minFontPx) so small annotation text stays legible. Original scene unchanged.',
        ),
      },
      outputSchema: exportPngOutputSchema,
    },
    async ({ canvasId, padding, scale, minFontPx }) => {
      const result = await withDaemon((client) =>
        exportTool.execute({ canvasId, padding, scale, minFontPx }, client),
      )
      // Return filePath in the text block and attach the image payload as a
      // separate ImageContent block. If reading fails, omit the image block and
      // fall back to returning only filePath.
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'image'; data: string; mimeType: string }
      > = [{ type: 'text', text: JSON.stringify({ filePath: result.filePath }) }]
      if (result.imageBase64) {
        content.push({ type: 'image', data: result.imageBase64, mimeType: 'image/png' })
      }
      return { structuredContent: result, content }
    },
  )

  registerToolWithAnnotations(server,
    viewportTool.name,
    {
      description: viewportTool.description,
      inputSchema: {
        canvasId: z.string().describe(
          'Canvas ID in "{workspaceId}/{slug}" form. Browser must be connected.',
        ),
        mode: z.enum(['fit', 'move']).optional().describe(
          '"fit" = scrollToContent + auto-zoom to frame the target elements. "move" = absolute scrollX/scrollY/zoom set. Default "fit".',
        ),
        elementIds: z.array(z.string()).optional().describe(
          'Target element ids for mode="fit". When omitted, fit-to-all-elements. Ignored in "move" mode.',
        ),
        padding: z.number().optional().describe(
          'Padding (px) around target bounding box for mode="fit". Default 40.',
        ),
        animate: z.boolean().optional().describe(
          'Animate the viewport transition. Default true. Only applies to mode="fit".',
        ),
        scrollX: z.number().optional().describe('Absolute scrollX (world coords) for mode="move".'),
        scrollY: z.number().optional().describe('Absolute scrollY (world coords) for mode="move".'),
        zoom: z.number().optional().describe('Absolute zoom (1.0 = 100%) for mode="move".'),
      },
      outputSchema: viewportSetOutputSchema,
    },
    async (args) => {
      const result = await withDaemon((client) => viewportTool.execute(args, client))
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    exportJsonTool.name,
    {
      description: exportJsonTool.description,
      inputSchema: {
        canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
        includeCustomFields: z.boolean().optional().describe(
          'When true, include custom Loro CRDT fields (parent/relX/relY etc.) in the output. Default false — exports a clean .excalidraw JSON compatible with Excalidraw desktop / excalidraw.com.',
        ),
      },
      outputSchema: canvasExportJsonOutputSchema,
    },
    async ({ canvasId, includeCustomFields }) => {
      const result = await withDaemon((client) =>
        exportJsonTool.execute({ canvasId, includeCustomFields }, client),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    autoLayoutTool.name,
    {
      description: autoLayoutTool.description,
      inputSchema: {
        canvasId: z.string(),
        direction: z.enum(['TB', 'LR']).optional(),
        layerGap: z.number().optional(),
        nodeGap: z.number().optional(),
        origin: z
          .object({
            x: z.number(),
            y: z.number(),
          })
          .optional(),
        pins: z
          .array(
            z.object({
              id: z.string(),
              rank: z.number().optional(),
              anchor: z.enum(['left', 'right', 'top', 'bottom', 'center']).optional(),
              column: z.number().optional(),
            }),
          )
          .optional(),
        groups: z
          .array(
            z.object({
              id: z.string(),
              elementIds: z.array(z.string()),
            }),
          )
          .optional(),
        groupGap: z.number().optional(),
      },
      outputSchema: canvasAutoLayoutOutputSchema,
    },
    async (args) => {
      const result = await withDaemon((client) => autoLayoutTool.execute(args, client))
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    libListTool.name,
    {
      description: libListTool.description,
      inputSchema: {
        libraryUrl: z.string().optional(),
        libraryPath: z.string().optional(),
        userLibraryName: z.string().optional(),
      },
      outputSchema: libraryListItemsOutputSchema,
    },
    async ({ libraryUrl, libraryPath, userLibraryName }) => {
      const result = await withDaemon((client) =>
        libListTool.execute({ libraryUrl, libraryPath, userLibraryName }, client),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    libInsertTool.name,
    {
      description: libInsertTool.description,
      inputSchema: {
        canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
        libraryUrl: z.string().optional().describe(
          'HTTPS URL to a .excalidrawlib file (e.g. libraries.excalidraw.com items). Pick exactly one of libraryUrl / libraryPath / userLibraryName.',
        ),
        libraryPath: z.string().optional().describe('Absolute path to a local .excalidrawlib file.'),
        userLibraryName: z.string().optional().describe(
          'Name of a user library saved via user_library_save (stored in ~/.whiteboard/.user-libraries/).',
        ),
        itemIndex: z.number().describe(
          'Item index within the library (0-based). Use library_list_items first to discover what is at each index.',
        ),
        target: z.object({ x: z.number(), y: z.number() }).describe(
          'World coords for the top-left of the inserted item. Internal element ids are remapped to fresh ids.',
        ),
        scale: z.number().optional().describe(
          'Scale multiplier (1.0 = original). Overrides metadata.scales when both are set.',
        ),
      },
      outputSchema: libInsertItemOutputSchema,
    },
    async ({ canvasId, libraryUrl, libraryPath, userLibraryName, itemIndex, target, scale }) => {
      const result = await withDaemon((client) =>
        libInsertTool.execute(
          { canvasId, libraryUrl, libraryPath, userLibraryName, itemIndex, target, scale },
          client,
        ),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    libInsertBatch.name,
    {
      description: libInsertBatch.description,
      inputSchema: {
        canvasId: z.string(),
        libraryUrl: z.string().optional(),
        libraryPath: z.string().optional(),
        userLibraryName: z.string().optional(),
        groupAs: z.string().optional(),
        scale: z.number().optional(),
        items: z
          .array(
            z.object({
              itemIndex: z.number(),
              target: z.object({ x: z.number(), y: z.number() }),
              groupAs: z.string().optional(),
              scale: z.number().optional(),
            }),
          )
          .min(1),
      },
      outputSchema: libraryInsertBatchOutputSchema,
    },
    async ({ canvasId, libraryUrl, libraryPath, userLibraryName, groupAs, scale, items }) => {
      const result = await withDaemon((client) =>
        libInsertBatch.execute(
          { canvasId, libraryUrl, libraryPath, userLibraryName, groupAs, scale, items },
          client,
        ),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    libInstall.name,
    {
      description: libInstall.description,
      inputSchema: {
        libraryUrl: z.string().describe(
          'HTTPS URL to a .excalidrawlib file. Persisted to the session config so the browser auto-restores it on reload. Validated by fetching once at install time.',
        ),
      },
      outputSchema: libraryInstallOutputSchema,
    },
    async ({ libraryUrl }) => {
      const result = await withDaemon((client) => libInstall.execute({ libraryUrl }, client))
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    libUninstall.name,
    {
      description: libUninstall.description,
      inputSchema: { libraryUrl: z.string() },
      outputSchema: installedUrlsOutputSchema,
    },
    async ({ libraryUrl }) => {
      const result = await withDaemon((client) =>
        libUninstall.execute({ libraryUrl }, client),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    libListInstalled.name,
    {
      description: libListInstalled.description,
      inputSchema: {},
      outputSchema: installedUrlsOutputSchema,
    },
    async () => {
      const result = await withDaemon((client) => libListInstalled.execute({}, client))
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    libCatalog.name,
    {
      description: libCatalog.description,
      inputSchema: { query: z.string().optional(), limit: z.number().optional() },
      outputSchema: libraryCatalogListOutputSchema,
    },
    async ({ query, limit }) => {
      const result = await libCatalog.execute({ query, limit })
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    userLibSave.name,
    {
      description: userLibSave.description,
      inputSchema: {
        name: z.string(),
        fromUrl: z.string().optional(),
        content: z.record(z.string(), z.unknown()).optional(),
      },
      outputSchema: userLibrarySaveOutputSchema,
    },
    async ({ name, fromUrl, content }) => {
      const result = await withDaemon((client) =>
        userLibSave.execute({ name, fromUrl, content }, client),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    userLibList.name,
    {
      description: userLibList.description,
      inputSchema: {},
      outputSchema: userLibraryListOutputSchema,
    },
    async () => {
      const result = await withDaemon((client) => userLibList.execute({}, client))
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    userLibRemove.name,
    {
      description: userLibRemove.description,
      inputSchema: { name: z.string() },
      outputSchema: userLibraryRemoveOutputSchema,
    },
    async ({ name }) => {
      const result = await withDaemon((client) => userLibRemove.execute({ name }, client))
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    userLibMetadataGet.name,
    {
      description: userLibMetadataGet.description,
      inputSchema: { name: z.string() },
      outputSchema: userLibraryMetadataManifestSchema,
    },
    async ({ name }) => {
      const result = await withDaemon((client) => userLibMetadataGet.execute({ name }, client))
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    userLibMetadataSet.name,
    {
      description: userLibMetadataSet.description,
      inputSchema: {
        name: z.string(),
        revision: z.number(),
        aliases: z.record(z.string(), z.number()).optional(),
        notes: z.record(z.string(), z.string()).optional(),
        scales: z.record(z.string(), z.number()).optional(),
      },
      outputSchema: userLibraryMetadataManifestSchema,
    },
    async ({ name, revision, aliases, notes, scales }) => {
      const result = await withDaemon((client) =>
        userLibMetadataSet.execute({ name, revision, aliases, notes, scales }, client),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    userLibMetadataDelete.name,
    {
      description: userLibMetadataDelete.description,
      inputSchema: {
        name: z.string(),
        revision: z.number(),
        aliasKeys: z.array(z.string()).optional(),
        noteKeys: z.array(z.string()).optional(),
        scaleKeys: z.array(z.string()).optional(),
      },
      outputSchema: userLibraryMetadataManifestSchema,
    },
    async ({ name, revision, aliasKeys, noteKeys, scaleKeys }) => {
      const result = await withDaemon((client) =>
        userLibMetadataDelete.execute(
          { name, revision, aliasKeys, noteKeys, scaleKeys },
          client,
        ),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    inspectTool.name,
    {
      description: inspectTool.description,
      inputSchema: {
        canvasId: z.string().describe(
          'Canvas ID in "{workspaceId}/{slug}" form. Returns elementCount + per-element { id, type, x, y, width, height, ... } for inspecting structure / debugging.',
        ),
      },
      outputSchema: canvasInspectOutputSchema,
    },
    async ({ canvasId }) => {
      const result = await withDaemon((client) => inspectTool.execute({ canvasId }, client))
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    listTemplates.name,
    {
      description: listTemplates.description,
      inputSchema: {},
      outputSchema: templateListOutputSchema,
    },
    async () => {
      const result = await listTemplates.execute()
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    insertTemplate.name,
    {
      description: insertTemplate.description,
      inputSchema: {
        canvasId: z.string(),
        templateId: z.string().optional(),
        templatePath: z.string().optional(),
        target: z.object({ x: z.number(), y: z.number() }),
        scale: z.number().optional(),
        variables: z.record(z.string(), z.string()).optional(),
      },
      outputSchema: templateInsertOutputSchema,
    },
    async ({ canvasId, templateId, templatePath, target, scale, variables }) => {
      const result = await withDaemon((client) =>
        insertTemplate.execute(
          { canvasId, templateId, templatePath, target, scale, variables },
          client,
        ),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    updateTool.name,
    {
      description: updateTool.description,
      inputSchema: {
        canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
        elementId: z.string().describe(
          'Target element id (from canvas_inspect or annotate result). Throws if not found.',
        ),
        patch: z.record(z.string(), z.unknown()).describe(
          'Partial element fields to merge (e.g. { text: "...", strokeColor: "#1971c2", x: 100, width: 200 }). Only valid Excalidraw element fields are applied; unknown keys are ignored.',
        ),
      },
      outputSchema: elementIdOutputSchema,
    },
    async ({ canvasId, elementId, patch }) => {
      const result = await withDaemon((client) =>
        updateTool.execute({ canvasId, elementId, patch }, client),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    deleteTool.name,
    {
      description: deleteTool.description,
      inputSchema: {
        canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
        elementId: z.string().describe(
          'Target element id. Soft-delete (tombstone) — element is removed from visible scene but kept in CRDT history. No-op if already deleted.',
        ),
      },
      outputSchema: elementIdOutputSchema,
    },
    async ({ canvasId, elementId }) => {
      const result = await withDaemon((client) => deleteTool.execute({ canvasId, elementId }, client))
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    deleteManyTool.name,
    {
      description: deleteManyTool.description,
      inputSchema: {
        canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
        elementIds: z.array(z.string()).min(1).describe(
          'Element ids to soft-delete (tombstone) in 1 snapshot/commit/broadcast. Always prefer this over multiple delete_element calls — it is faster and atomic.',
        ),
      },
      outputSchema: deletedElementsOutputSchema,
    },
    async ({ canvasId, elementIds }) => {
      const result = await withDaemon((client) =>
        deleteManyTool.execute({ canvasId, elementIds }, client),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    assignGroupTool.name,
    {
      description: assignGroupTool.description,
      inputSchema: {
        canvasId: z.string(),
        groupId: z.string(),
        elementIds: z.array(z.string()).min(1),
      },
      outputSchema: assignGroupOutputSchema,
    },
    async ({ canvasId, groupId, elementIds }) => {
      const result = await withDaemon((client) =>
        assignGroupTool.execute({ canvasId, groupId, elementIds }, client),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    deleteGroupT.name,
    {
      description: deleteGroupT.description,
      inputSchema: { canvasId: z.string(), groupId: z.string() },
      outputSchema: deletedElementsOutputSchema,
    },
    async ({ canvasId, groupId }) => {
      const result = await withDaemon((client) =>
        deleteGroupT.execute({ canvasId, groupId }, client),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    listGroupsT.name,
    {
      description: listGroupsT.description,
      inputSchema: { canvasId: z.string() },
      outputSchema: listGroupsOutputSchema,
    },
    async ({ canvasId }) => {
      const result = await withDaemon((client) => listGroupsT.execute({ canvasId }, client))
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    moveTool.name,
    {
      description: moveTool.description,
      inputSchema: {
        canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
        elementIds: z.array(z.string()).min(1).describe(
          'Element ids to move together. All ids in the same group are translated by the same (dx, dy) in one batched commit.',
        ),
        dx: z.number().describe('Horizontal translation in world coordinates (px). Negative = left.'),
        dy: z.number().describe('Vertical translation in world coordinates (px). Negative = up.'),
      },
      outputSchema: elementIdsOutputSchema,
    },
    async ({ canvasId, elementIds, dx, dy }) => {
      const result = await withDaemon((client) =>
        moveTool.execute({ canvasId, elementIds, dx, dy }, client),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    reorderTool.name,
    {
      description: reorderTool.description,
      inputSchema: {
        canvasId: z.string(),
        elementIds: z.array(z.string()).min(1),
        action: z.enum(['front', 'back']),
      },
      outputSchema: reorderOutputSchema,
    },
    async ({ canvasId, elementIds, action }) => {
      const result = await withDaemon((client) =>
        reorderTool.execute({ canvasId, elementIds, action }, client),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    clearTool.name,
    {
      description: clearTool.description,
      inputSchema: { canvasId: z.string() },
      outputSchema: clearedCountOutputSchema,
    },
    async ({ canvasId }) => {
      const result = await withDaemon((client) => clearTool.execute({ canvasId }, client))
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    checkpointSave.name,
    {
      description: checkpointSave.description,
      inputSchema: {
        canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form to snapshot.'),
        id: z.string().regex(/^[a-zA-Z0-9._-]+$/, { message: 'Invalid checkpoint id' }).optional().describe(
          'Optional checkpoint id. When omitted, a fresh nanoid is generated. Must match /^[a-zA-Z0-9._-]+$/ (no path traversal).',
        ),
      },
      outputSchema: checkpointSaveOutputSchema,
    },
    async ({ canvasId, id }) => {
      const result = await withDaemon((client) => checkpointSave.execute({ canvasId, id }, client))
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    checkpointRestore.name,
    {
      description: checkpointRestore.description,
      inputSchema: {
        checkpointId: z.string().describe(
          'Checkpoint id returned by checkpoint_save. Throws if not found.',
        ),
        targetSlug: z.string().describe(
          'Slug of the canvas to restore into. Created if it does not exist.',
        ),
        overwrite: z.boolean().optional().describe(
          'When true, replace an existing canvas with the same slug. Default false — existing slug throws "already exists".',
        ),
      },
      outputSchema: checkpointRestoreOutputSchema,
    },
    async ({ checkpointId, targetSlug, overwrite }) => {
      const result = await withDaemon((client) =>
        checkpointRestore.execute({ checkpointId, targetSlug, overwrite }, workspaceId, client),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    frameCreate.name,
    {
      description: frameCreate.description,
      inputSchema: {
        canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
        x: z.number().optional().describe(
          'Frame top-left x (world coords). Ignored when memberIds is provided (auto-fits to bbox).',
        ),
        y: z.number().optional().describe('Frame top-left y. Ignored when memberIds is provided.'),
        width: z.number().optional().describe('Frame width (px). Ignored when memberIds is provided.'),
        height: z.number().optional().describe('Frame height (px). Ignored when memberIds is provided.'),
        name: z.string().optional().describe(
          'Frame label rendered at the top edge. Treat this as a section heading; avoid duplicating it inside the frame.',
        ),
        memberIds: z.array(z.string()).optional().describe(
          'Existing element ids to enclose. Frame auto-fits to their bounding box at creation time. Children get their frameId set.',
        ),
        padding: z.number().optional().describe(
          'Padding (px) around the member bbox when memberIds is set. Default 24.',
        ),
      },
      outputSchema: createFrameOutputSchema,
    },
    async ({ canvasId, x, y, width, height, name, memberIds, padding }) => {
      const result = await withDaemon((client) =>
        frameCreate.execute({ canvasId, x, y, width, height, name, memberIds, padding }, client),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    frameUpdateMembers.name,
    {
      description: frameUpdateMembers.description,
      inputSchema: {
        canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
        frameId: z.string().describe(
          'Existing frame element id (returned by create_frame). Throws if not a frame.',
        ),
        add: z.array(z.string()).optional().describe(
          'Element ids to add to the frame. Their frameId is set, and the frame bbox auto-grows to contain them.',
        ),
        remove: z.array(z.string()).optional().describe(
          'Element ids to remove from the frame (frameId cleared). Frame bbox shrinks to fit remaining members.',
        ),
        padding: z.number().optional().describe(
          'Padding (px) around the resulting member bbox. Default 24.',
        ),
      },
      outputSchema: updateFrameMembersOutputSchema,
    },
    async ({ canvasId, frameId, add, remove, padding }) => {
      const result = await withDaemon((client) =>
        frameUpdateMembers.execute({ canvasId, frameId, add, remove, padding }, client),
      )
      return structuredJsonResult(result)
    },
  )

  registerToolWithAnnotations(server,
    embedCreate.name,
    {
      description: embedCreate.description,
      inputSchema: {
        canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
        url: z.string().describe(
          'External URL to embed (YouTube / Figma / CodeSandbox / etc.). Excalidraw allowlist-checks at render time; non-allowlisted URLs require user approval in the browser. The element is created either way, so you can stack annotations on it before validation.',
        ),
        x: z.number().optional().describe('Embed top-left x. Default centered on viewport.'),
        y: z.number().optional().describe('Embed top-left y. Default centered on viewport.'),
        width: z.number().optional().describe('Embed width (px). Default 480.'),
        height: z.number().optional().describe('Embed height (px). Default 320.'),
      },
      outputSchema: createEmbedOutputSchema,
    },
    async ({ canvasId, url, x, y, width, height }) => {
      const result = await withDaemon((client) =>
        embedCreate.execute({ canvasId, url, x, y, width, height }, client),
      )
      return structuredJsonResult(result)
    },
  )

  return server
}

export async function main() {
  // The HTTP daemon runs prepareDataDir in src/server/index.ts; the stdio
  // entrypoint reaches createExcalidrawMcpServer first, so call the same
  // hook here to keep schema and v0 import bootstrapping symmetric.
  const { prepareDataDir } = await import('../store/db/prepare.js')
  await prepareDataDir(DATA_DIR)
  const server = await createExcalidrawMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

const isEntryPoint = isDirectEntryPoint(import.meta.url)
if (isEntryPoint) {
  main().catch((err) => {
    process.stderr.write(`MCP server error: ${err}\n`)
    process.exit(1)
  })
}
