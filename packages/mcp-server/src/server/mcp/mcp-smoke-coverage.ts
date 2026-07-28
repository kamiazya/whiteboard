/**
 * Classification of all registered MCP tools by smoke-test coverage level.
 *
 * ALL_REGISTERED_TOOLS is the authoritative list that mirrors what
 * registerExcalidrawMcpServer (index.ts) registers at runtime.
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

// Authoritative list — keep in sync with registerToolWithAnnotations calls in index.ts.
export const ALL_REGISTERED_TOOLS = [
  'align_elements',
  'annotate',
  'annotate_batch',
  'assign_to_group',
  'body_patch',
  'canvas_auto_layout',
  'canvas_clear',
  'canvas_create',
  'canvas_digest',
  'canvas_export_json_canvas',
  'canvas_export_okf',
  'canvas_inspect',
  'canvas_list',
  'canvas_open',
  'canvas_render_svg',
  'canvas_view',
  'create_embed',
  'create_frame',
  'create_pairing_link',
  'delete_element',
  'delete_elements',
  'delete_group',
  'distribute_elements',
  'edge_patch',
  'export_canvas',
  'export_svg',
  'facet_set',
  'list_groups',
  'load_image',
  'move_elements',
  'node_patch',
  'optimize_canvases',
  'reorder_elements',
  'template_insert',
  'template_list',
  'update_element',
  'update_frame_members',
  'version_list',
  'version_restore',
  'version_save',
  'viewport_set',
  'wb_canvas_create',
  'wb_canvas_delete',
  'wb_canvas_get',
  'wb_canvas_list',
] as const satisfies readonly string[]

export const COVERED_TOOLS = [
  'canvas_create',
  'canvas_list',
  'annotate',
  'create_frame',
  'create_pairing_link',
  'canvas_inspect',
  'canvas_view',
  'facet_set',
  'version_save',
  'version_restore',
  'version_list',
  'export_svg',
  'export_canvas',
  'wb_canvas_create',
] as const

export const ERROR_PATH_ONLY_TOOLS = ['viewport_set'] as const

// MCP Apps (SEP-1865) UI-linked tools: their registered definition carries
// `_meta.ui.resourceUri` pointing at CANVAS_VIEW_RESOURCE_URI (mcp-apps.ts).
// canvas_open and export_canvas are deliberately excluded — see the
// rationale comment at the canvas_view registration in tool-registration.ts.
export const UI_LINKED_TOOLS = ['canvas_view'] as const

export const UNIT_ONLY_TOOLS = [
  'align_elements',
  'annotate_batch',
  'assign_to_group',
  'body_patch',
  'canvas_auto_layout',
  'canvas_clear',
  'canvas_digest',
  'canvas_export_json_canvas',
  'canvas_export_okf',
  'canvas_open',
  'canvas_render_svg',
  'create_embed',
  'delete_element',
  'delete_elements',
  'delete_group',
  'distribute_elements',
  'edge_patch',
  'list_groups',
  'load_image',
  'move_elements',
  'node_patch',
  'optimize_canvases',
  'reorder_elements',
  'template_insert',
  'template_list',
  'update_element',
  'update_frame_members',
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
