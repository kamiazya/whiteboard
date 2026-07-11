// Annotation profiles and TOOL_PROFILES map for MCP tool registration.
//
// MCP spec: https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations
// Clients (Claude Code / Codex) use read-only / destructive flags for approval
// UI and auto-run policy decisions.
// openWorldHint: false means the tool operates only on local canvas state.
export const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const
export const DESTRUCTIVE_IDEMPOTENT = {
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const
export const MUTATING_IDEMPOTENT = { idempotentHint: true, openWorldHint: false } as const
export const MUTATING = { openWorldHint: false } as const

// Tools that fetch external URLs declare openWorldHint: true.
export const READ_ONLY_EXTERNAL = { readOnlyHint: true, openWorldHint: true } as const
export const MUTATING_EXTERNAL = { openWorldHint: true } as const

// Map from tool name to annotation profile and human-friendly title. Used by
// registerToolWithAnnotations when building McpServer annotations.
export type AnnotationProfile = Readonly<Record<string, boolean>>
export const TOOL_PROFILES: Record<string, { profile: AnnotationProfile; title: string }> = {
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
  align_elements: {
    profile: MUTATING_IDEMPOTENT,
    title: 'Align elements to a shared edge or centre',
  },
  distribute_elements: {
    profile: MUTATING_IDEMPOTENT,
    title: 'Distribute elements with even spacing',
  },
  reorder_elements: { profile: MUTATING_IDEMPOTENT, title: 'Reorder elements (front/back)' },
  viewport_set: { profile: MUTATING_IDEMPOTENT, title: 'Set browser viewport' },
  palette_set: { profile: MUTATING_IDEMPOTENT, title: 'Set palette entries' },
  user_library_metadata_set: { profile: MUTATING_IDEMPOTENT, title: 'Set user library metadata' },
  assign_to_group: { profile: MUTATING_IDEMPOTENT, title: 'Assign elements to group' },
  update_frame_members: { profile: MUTATING_IDEMPOTENT, title: 'Update frame members' },
  optimize_canvases: {
    profile: MUTATING_IDEMPOTENT,
    title: 'Optimize canvas storage (compact Loro op-log)',
  },

  // Mutating non-idempotent (side effects / new IDs / state changes)
  //
  // create_pairing_link never mutates canvas state, but its response embeds the
  // live daemon bearer token (see pairing-link.ts). readOnlyHint drives client
  // auto-run/approval policy, so annotating this as read-only would let a client
  // silently disclose a full-access credential without a human approval step.
  create_pairing_link: { profile: MUTATING, title: 'Create daemon pairing link' },
  canvas_create: { profile: MUTATING, title: 'Create canvas' },
  annotate: { profile: MUTATING, title: 'Add annotation element' },
  annotate_batch: { profile: MUTATING, title: 'Add multiple annotation elements' },
  load_image: { profile: MUTATING, title: 'Load image into canvas' },
  canvas_auto_layout: { profile: MUTATING, title: 'Auto-layout canvas (DAG)' },
  template_insert: { profile: MUTATING, title: 'Insert template parts' },
  create_frame: { profile: MUTATING, title: 'Create frame container' },
  create_embed: { profile: MUTATING, title: 'Embed external URL into canvas' },
  library_insert_item: { profile: MUTATING, title: 'Insert library item' },
  library_insert_batch: { profile: MUTATING, title: 'Insert multiple library items' },
  user_library_save: { profile: MUTATING, title: 'Save user library' },
  version_save: { profile: MUTATING, title: 'Save labeled version' },
  version_restore: { profile: MUTATING, title: 'Restore canvas from version' },
  version_list: { profile: READ_ONLY, title: 'List versions' },

  // Mutating + external (fetches over HTTPS and writes daemon state)
  library_install: { profile: MUTATING_EXTERNAL, title: 'Install library from HTTPS URL' },
}
