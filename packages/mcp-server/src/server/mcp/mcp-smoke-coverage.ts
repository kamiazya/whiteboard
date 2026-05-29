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
  'annotate',
  'annotate_batch',
  'assign_to_group',
  'canvas_auto_layout',
  'canvas_clear',
  'canvas_create',
  'canvas_export_json',
  'canvas_inspect',
  'canvas_list',
  'canvas_open',
  'create_embed',
  'create_frame',
  'delete_element',
  'delete_elements',
  'delete_group',
  'export_png',
  'library_catalog_list',
  'library_insert_batch',
  'library_insert_item',
  'library_install',
  'library_list_installed',
  'library_list_items',
  'library_uninstall',
  'list_groups',
  'load_image',
  'move_elements',
  'palette_delete',
  'palette_get',
  'palette_set',
  'reorder_elements',
  'template_insert',
  'template_list',
  'update_element',
  'update_frame_members',
  'user_library_list',
  'user_library_metadata_delete',
  'user_library_metadata_get',
  'user_library_metadata_set',
  'user_library_remove',
  'user_library_save',
  'version_list',
  'version_restore',
  'version_save',
  'viewport_set',
] as const satisfies readonly string[]

export const COVERED_TOOLS = [
  'canvas_create',
  'canvas_list',
  'annotate',
  'create_frame',
  'canvas_inspect',
  'version_save',
  'version_restore',
  'version_list',
  'canvas_export_json',
  'palette_get',
  'library_list_installed',
  'library_list_items',
  'library_uninstall',
] as const

export const ERROR_PATH_ONLY_TOOLS = [
  'viewport_set',
  'export_png',
] as const

export const UNIT_ONLY_TOOLS = [
  'annotate_batch',
  'assign_to_group',
  'canvas_auto_layout',
  'canvas_clear',
  'canvas_open',
  'create_embed',
  'delete_element',
  'delete_elements',
  'delete_group',
  'library_catalog_list',
  'library_insert_batch',
  'library_insert_item',
  'list_groups',
  'load_image',
  'move_elements',
  'palette_delete',
  'palette_set',
  'reorder_elements',
  'template_insert',
  'template_list',
  'update_element',
  'update_frame_members',
  'user_library_list',
  'user_library_metadata_delete',
  'user_library_metadata_get',
  'user_library_metadata_set',
  'user_library_remove',
  'user_library_save',
] as const

export type DeferredTool = {
  name: string
  reason: string
  unblock: string
}

export const DEFERRED_TOOLS: DeferredTool[] = [
  {
    name: 'library_install',
    reason: 'Success path calls fetchExternalLibraryPayload() → global fetch. Additionally, validateExternalUrl() rejects localhost and private-range IPs, so a plain node:http.createServer stub is blocked before the fetch even fires.',
    unblock: 'Use nock or MSW to intercept fetch at the DNS/request level (bypasses validateExternalUrl), OR make the external-URL lookup injectable so the smoke can whitelist a loopback address.',
  },
]
