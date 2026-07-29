// Annotation profiles and TOOL_PROFILES map for MCP tool registration.
//
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
export const MUTATING = { openWorldHint: false } as const

// Map from tool name to annotation profile and human-friendly title. Used by
// registerToolWithAnnotations when building McpServer annotations.
export type AnnotationProfile = Readonly<Record<string, boolean>>
export const TOOL_PROFILES: Record<string, { profile: AnnotationProfile; title: string }> = {
  // OpenCanvas tools (server-core)
  facet_set: { profile: MUTATING_IDEMPOTENT, title: 'Set canvas facets' },
  node_patch: { profile: MUTATING_IDEMPOTENT, title: 'Patch spatial canvas node' },
  edge_patch: { profile: MUTATING_IDEMPOTENT, title: 'Patch spatial canvas edge' },
  body_patch: { profile: MUTATING, title: 'Patch canvas markdown body' },
  canvas_render_svg: { profile: READ_ONLY, title: 'Render canvas as SVG' },
  canvas_digest: { profile: READ_ONLY, title: 'Generate AI-facing canvas digest' },
  canvas_export_okf: { profile: READ_ONLY, title: 'Export canvas as OKF Markdown' },
  canvas_export_json_canvas: { profile: READ_ONLY, title: 'Export canvas as JSON Canvas' },
  wb_canvas_create: { profile: MUTATING, title: 'Create OpenCanvas canvas' },
  wb_canvas_list: { profile: READ_ONLY, title: 'List OpenCanvas canvases' },
  wb_canvas_get: { profile: READ_ONLY, title: 'Get OpenCanvas canvas' },
  wb_canvas_delete: { profile: DESTRUCTIVE_IDEMPOTENT, title: 'Delete OpenCanvas canvas' },
  version_save: { profile: MUTATING, title: 'Save labeled version' },
  version_restore: { profile: MUTATING, title: 'Restore canvas from version' },
  version_list: { profile: READ_ONLY, title: 'List versions' },
  reindex: { profile: READ_ONLY, title: 'Rebuild workspace index' },
}
