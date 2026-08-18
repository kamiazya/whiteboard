/**
 * Classification of all registered MCP tools by smoke-test coverage level.
 *
 * ALL_REGISTERED_TOOLS is the authoritative list that mirrors what
 * createMcpServer (index.ts) registers at runtime via registerDocumentTools.
 * It is defined independently of the four category arrays below so that the
 * meta-property test can verify category completeness without self-reference.
 *
 * Adding or removing a tool touches four places, and each is checked against
 * the one below it rather than against a copy of itself:
 *   1. ALL_REGISTERED_TOOLS here — compared to a REAL server's tools/list by
 *      the mcp-smoke checkpoint (mcp-e2e-checkpoint.smoke-impl.ts), so this
 *      is the list that is held to reality rather than to another list.
 *   2. Exactly one of the category arrays below — the property test
 *      (tool-structured-content.property.test.ts) fails if the categories do
 *      not partition ALL_REGISTERED_TOOLS exactly.
 *   3. TOOL_PROFILES (tool-profiles.ts) — tool-naming.test.ts fails if it
 *      does not cover ALL_REGISTERED_TOOLS exactly. A registered tool with
 *      no profile silently downgrades to MUTATING with its name as its title.
 *   4. EXPECTED_TOOLS in scripts/smoke/mcp-e2e-smoke.mjs. Deliberately a
 *      separate copy: that smoke drives the server as a subprocess, so
 *      importing this list would make it agree with itself instead of
 *      catching packaging drift. It is a plain .mjs script and cannot import
 *      this module anyway.
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

// Authoritative list — keep in sync with registerDocumentTools calls.
export const ALL_REGISTERED_TOOLS = [
  'wb_body_patch',
  'wb_scene_digest',
  'wb_canvas_snapshot',
  'wb_canvas_edit',
  'wb_document_set',
  'wb_scene_render',
  'wb_facet_set',
  'wb_version_list',
  'wb_version_restore',
  'wb_version_save',
  'wb_document_create',
  'wb_document_get',
  'wb_document_delete',
  'wb_document_resolve',
  'wb_document_list',
  'canvas_view',
] as const satisfies readonly string[]

export const COVERED_TOOLS = [
  'wb_document_set',
  'wb_canvas_snapshot',
  'wb_canvas_edit',
  'wb_facet_set',
  'wb_version_save',
  'wb_version_restore',
  'wb_version_list',
  'wb_document_create',
  'canvas_view',
] as const

// Empty since the seeding batch gives every later step something to act on: every tool
// either reaches its success path in the smoke or is listed below.
export const ERROR_PATH_ONLY_TOOLS = [] as const

// MCP Apps (SEP-1865) UI-linked tools: their registered definition carries
// `_meta.ui.resourceUri` pointing at CANVAS_VIEW_RESOURCE_URI (mcp-apps.ts).
//
// This is not a cross-cutting category like the ones above — it is a
// SEPARATE axis, so an entry here also belongs to exactly one coverage
// category. Two guards read it: the ADR-0009 naming check exempts these
// from `wb_<entity>_<action>` (point 7 keeps them outside the data plane),
// and document-tools.test.ts asserts each one's real registration
// actually carries the linkage — without that second guard this list would
// be a claim nobody checks.
export const UI_LINKED_TOOLS = ['canvas_view'] as const

export const UNIT_ONLY_TOOLS = [
  'wb_body_patch',
  'wb_scene_digest',
  'wb_scene_render',
  'wb_document_get',
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
