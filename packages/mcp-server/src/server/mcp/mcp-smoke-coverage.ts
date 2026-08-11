/**
 * Classification of all registered MCP tools by smoke-test coverage level.
 *
 * ALL_REGISTERED_TOOLS is the authoritative list that mirrors what
 * createMcpServer (index.ts) registers at runtime via registerOpenCanvasTools.
 * It is defined independently of the four category arrays below so that the
 * meta-property test can verify category completeness without self-reference.
 *
 * When adding or removing a tool:
 *   1. Update ALL_REGISTERED_TOOLS.
 *   2. Add the tool to exactly one of the four category arrays.
 *   3. The property test (tool-structured-content.property.test.ts) will fail
 *      if the categories do not cover ALL_REGISTERED_TOOLS exactly.
 *   4. The smoke (mcp-e2e-checkpoint.mjs / smoke-impl.ts) will fail if tools/list no longer
 *      matches ALL_REGISTERED_TOOLS.
 *
 * Category meanings:
 *   COVERED_TOOLS       — exercised end-to-end in the smoke (success path).
 *   ERROR_PATH_ONLY     — exercised only via their expected error path
 *                         (no browser client → immediate rejection). Route
 *                         wiring is confirmed; success path needs a live browser.
 *   UNIT_ONLY_TOOLS     — covered by unit tests but not yet wired into the smoke.
 *   DEFERRED_TOOLS      — require infrastructure the offline smoke cannot provide.
 *                         Each entry carries reason and unblock.
 */

// Authoritative list — keep in sync with registerOpenCanvasTools calls.
export const ALL_REGISTERED_TOOLS = [
  'body_patch',
  'canvas_digest',
  'canvas_export_json_canvas',
  'canvas_export_okf',
  'canvas_import_okf',
  'canvas_render_svg',
  'edge_lock',
  'edge_patch',
  'facet_set',
  'node_lock',
  'node_patch',
  'tidy_canvas',
  'version_list',
  'version_restore',
  'version_save',
  'wb_canvas_create',
  'wb_canvas_delete',
  'wb_canvas_get',
  'wb_canvas_list',
] as const satisfies readonly string[]

export const COVERED_TOOLS = [
  'canvas_import_okf',
  'node_lock',
  'tidy_canvas',
  'facet_set',
  'version_save',
  'version_restore',
  'version_list',
  'wb_canvas_create',
] as const

export const ERROR_PATH_ONLY_TOOLS = ['edge_lock'] as const

// MCP Apps (SEP-1865) UI-linked tools: their registered definition carries
// `_meta.ui.resourceUri` pointing at CANVAS_VIEW_RESOURCE_URI (mcp-apps.ts).
export const UI_LINKED_TOOLS = [] as const

export const UNIT_ONLY_TOOLS = [
  'body_patch',
  'canvas_digest',
  'canvas_export_json_canvas',
  'canvas_export_okf',
  'canvas_render_svg',
  'edge_patch',
  'node_patch',
  'wb_canvas_delete',
  'wb_canvas_get',
  'wb_canvas_list',
] as const

export type DeferredTool = {
  name: string
  reason: string
  unblock: string
}

export const DEFERRED_TOOLS: DeferredTool[] = []
