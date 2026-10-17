/**
 * What a credential on server mode's `/mcp` must hold to call each tool, on
 * top of the `mcp:call` that opens the endpoint. Each entry is the scope the
 * tool's `/api` twin is registered under in `route-scope-registry.ts`, so one
 * grant reaches the same operations whichever surface it arrives through:
 * a token scoped `canvas:read mcp:call` reads documents over `/mcp` and
 * deletes none, exactly as it would over `/api`.
 *
 * Document create / set / delete sit at `workspace:write` because that is what
 * the `/api/v1/workspaces` document surface asks. Restore needs only
 * `versions:write`, as the `/api` restore route does.
 *
 * A tool with no entry is refused rather than run with `mcp:call` alone;
 * `mcp-tool-scopes.test.ts` holds the keys to the registered tool list.
 */
import type { AuthScope } from './auth-strategy.js'

export const MCP_TOOL_SCOPES: Readonly<Record<string, readonly AuthScope[]>> = {
  wb_facet_list: ['canvas:read'],
  wb_scene_render: ['canvas:read'],
  wb_canvas_snapshot: ['canvas:read'],
  wb_document_get: ['canvas:read'],
  wb_document_search: ['canvas:read'],
  canvas_view: ['canvas:read'],
  wb_document_list: ['workspace:read'],
  wb_version_list: ['versions:read'],

  wb_facet_set: ['canvas:write'],
  wb_canvas_edit: ['canvas:write'],
  wb_body_edit: ['canvas:write'],
  wb_thread_edit: ['canvas:write'],
  // It stores nothing, but it moves what another person is looking at, which
  // a read-only grant should not be able to do.
  wb_viewport_set: ['canvas:write'],
  wb_workspace_edit: ['workspace:write'],
  wb_version_save: ['versions:write'],
  wb_version_restore: ['versions:write'],
}
