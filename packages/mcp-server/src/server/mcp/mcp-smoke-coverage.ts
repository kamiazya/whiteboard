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
  'wb_body_patch',
  'wb_scene_digest',
  'wb_document_set',
  'wb_scene_render',
  'wb_edge_lock',
  'wb_edge_add',
  'wb_edge_patch',
  'wb_facet_set',
  'wb_node_add',
  'wb_node_lock',
  'wb_node_patch',
  'wb_canvas_tidy',
  'wb_version_list',
  'wb_version_restore',
  'wb_version_save',
  'wb_document_create',
  'wb_document_get',
  'wb_document_delete',
  'wb_document_resolve',
  'wb_document_list',
] as const satisfies readonly string[]

export const COVERED_TOOLS = [
  'wb_document_set',
  'wb_node_add',
  'wb_edge_add',
  'wb_edge_lock',
  'wb_edge_patch',
  'wb_node_lock',
  'wb_canvas_tidy',
  'wb_facet_set',
  'wb_version_save',
  'wb_version_restore',
  'wb_version_list',
  'wb_document_create',
] as const

// Empty since wb_edge_add gave wb_edge_lock an edge to lock: every tool
// either reaches its success path in the smoke or is listed below.
export const ERROR_PATH_ONLY_TOOLS = [] as const

// MCP Apps (SEP-1865) UI-linked tools: their registered definition carries
// `_meta.ui.resourceUri` pointing at CANVAS_VIEW_RESOURCE_URI (mcp-apps.ts).
export const UI_LINKED_TOOLS = [] as const

export const UNIT_ONLY_TOOLS = [
  'wb_body_patch',
  'wb_scene_digest',
  'wb_scene_render',
  'wb_document_get',
  'wb_node_patch',
  'wb_document_delete',
  'wb_document_resolve',
  'wb_document_list',
] as const

export type DeferredTool = {
  name: string
  reason: string
  unblock: string
}

export const DEFERRED_TOOLS: DeferredTool[] = []
