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
const DESTRUCTIVE = { destructiveHint: true, openWorldHint: false } as const
export const MUTATING = { openWorldHint: false } as const

// Map from tool name to annotation profile and human-friendly title. Used by
// registerToolWithAnnotations when building McpServer annotations.
export type AnnotationProfile = Readonly<Record<string, boolean>>
export const TOOL_PROFILES: Record<string, { profile: AnnotationProfile; title: string }> = {
  // Document tools (server-core)
  wb_facet_set: {
    profile: MUTATING_IDEMPOTENT,
    title: 'Set the OKF frontmatter facets of a document',
  },
  wb_edge_add: { profile: MUTATING, title: 'Connect two nodes on the spatial canvas' },
  wb_node_add: { profile: MUTATING, title: 'Add a node to the spatial canvas' },
  wb_node_patch: { profile: MUTATING_IDEMPOTENT, title: 'Patch a node on the spatial canvas' },
  wb_edge_patch: { profile: MUTATING_IDEMPOTENT, title: 'Patch an edge on the spatial canvas' },
  wb_node_lock: {
    profile: MUTATING_IDEMPOTENT,
    title: 'Lock or unlock a node on the spatial canvas',
  },
  wb_edge_lock: {
    profile: MUTATING_IDEMPOTENT,
    title: 'Lock or unlock an edge on the spatial canvas',
  },
  wb_canvas_tidy: { profile: MUTATING_IDEMPOTENT, title: 'Tidy the spatial canvas layout' },
  wb_canvas_edit: {
    // Destructive because a batch may carry node.remove / edge.remove, and
    // NOT idempotent because an add refuses an id already on the canvas.
    profile: DESTRUCTIVE,
    title: 'Apply a batch of edits to the spatial canvas',
  },
  wb_body_patch: { profile: MUTATING, title: 'Patch the markdown body of a document' },
  wb_scene_render: { profile: READ_ONLY, title: 'Render the laid-out scene as SVG' },
  wb_scene_digest: { profile: READ_ONLY, title: 'Summarise the laid-out scene' },
  wb_canvas_snapshot: {
    profile: READ_ONLY,
    title: 'Read a spatial canvas as a compact snapshot',
  },
  wb_document_set: { profile: MUTATING, title: 'Replace a document from OKF Markdown' },
  wb_document_get: { profile: READ_ONLY, title: 'Read a document in its own format' },
  wb_document_create: { profile: MUTATING, title: 'Create a document' },
  wb_document_list: { profile: READ_ONLY, title: 'List the documents in a workspace' },
  wb_document_resolve: { profile: READ_ONLY, title: 'Resolve a document id to its placement' },
  wb_document_delete: { profile: DESTRUCTIVE_IDEMPOTENT, title: 'Delete a document' },
  wb_version_save: { profile: MUTATING, title: 'Save a labelled version of a document' },
  wb_version_restore: { profile: MUTATING, title: 'Restore a document from a version' },
  wb_version_list: { profile: READ_ONLY, title: 'List the versions of a document' },
  // The MCP Apps UI tool. ADR-0009 point 7 keeps it outside the `wb_` data
  // plane on purpose: it is a UI contract with the host, not a tool a model
  // reads data through.
  canvas_view: { profile: READ_ONLY, title: 'Show a canvas inline in the chat' },
}
