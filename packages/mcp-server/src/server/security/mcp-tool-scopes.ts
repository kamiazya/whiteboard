/**
 * What a credential on server mode's `/mcp` must hold to call each tool, on
 * top of the `mcp:call` that opens the endpoint. Each entry is the scope the
 * tool's `/api` twin is registered under in `route-scope-registry.ts`, so one
 * grant reaches the same operations whichever surface it arrives through:
 * a token scoped `canvas:read mcp:call` reads documents over `/mcp` and
 * deletes none, exactly as it would over `/api`. `api-v1-tool-twin-scopes.test.ts`
 * holds every `/api/v1` route to its twin's entry here.
 *
 * Document create / move / delete sit at `workspace:write` because that is what
 * the `/api/v1/workspaces` document surface asks. A `wb_workspace_edit` batch
 * that writes a body — a `document.set`, or a create carrying markdown — also
 * needs `canvas:write`, as content does on every surface (`MCP_TOOL_INPUT_SCOPES`;
 * the `/api/v1` create judges the same body by `createBodyScopes`). Restore in place needs only
 * `versions:write`, as the `/api` restore route does; a call that asks for
 * more is held to more by `MCP_TOOL_INPUT_SCOPES`.
 *
 * A tool with no entry is refused rather than run with `mcp:call` alone;
 * `mcp-tool-scopes.test.ts` holds the keys to the registered tool list.
 */
import type { AuthScope } from './auth-strategy.js'
import { carriesBody, restoreScopes } from './route-scope-registry.js'

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

/**
 * What a call needs on top of its tool's entry, read off what it asks for —
 * the same answer its `/api` twin gives the same request. The document's path
 * is not known before the tool resolves it, so any `targetPath` counts as
 * another document here; a restore in place names none.
 */
export const MCP_TOOL_INPUT_SCOPES: Readonly<
  Record<string, (input: Readonly<Record<string, unknown>>) => readonly AuthScope[]>
> = {
  wb_version_restore: (input) => restoreScopes(input),
  wb_workspace_edit: (input) => (batchWritesContent(input.ops) ? ['canvas:write'] : []),
}

function batchWritesContent(ops: unknown): boolean {
  if (!Array.isArray(ops)) return false
  return ops.some((op: unknown) => {
    if (op === null || typeof op !== 'object') return false
    const named = op as { readonly op?: unknown; readonly markdown?: unknown }
    return named.op === 'document.set' || (named.op === 'document.create' && carriesBody(named))
  })
}
