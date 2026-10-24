// One grant reaches the same operations whichever surface it arrives
// through: `MCP_TOOL_SCOPES` promises each tool asks the scope its `/api`
// twin is registered under. This holds that promise from the HTTP side —
// every route server-core's createServer mounts under /api/v1 either names
// the tool it is the twin of, and must resolve to that tool's scopes, or says
// why it has none and which scopes it takes instead. Both directions fail: a
// mounted route with no entry, and an entry naming no mounted route.

import { createServer } from '@kamiazya/whiteboard-server-core'
import { describe, expect, it } from 'vitest'
import { createContainer, resolveServerDeps } from '../../di/container.js'
import { storeMemoryModule } from '../../shared/test-utils/store-memory.module.js'
import type { AuthScope } from './auth-strategy.js'
import { MCP_TOOL_INPUT_SCOPES, MCP_TOOL_SCOPES } from './mcp-tool-scopes.js'
import { createBodyScopes, resolveApiRouteScope } from './route-scope-registry.js'

type V1RouteScope =
  | { readonly twin: keyof typeof MCP_TOOL_SCOPES }
  | { readonly noTwin: string; readonly scopes: readonly AuthScope[] }

const WS = '/api/v1/workspaces/:workspaceId'
const DOC = `${WS}/documents/:documentId`

const V1_ROUTE_SCOPES: Readonly<Record<string, V1RouteScope>> = {
  [`POST ${WS}/documents`]: { twin: 'wb_workspace_edit' },
  [`GET ${WS}/documents`]: { twin: 'wb_document_list' },
  // Resolving one id answers one row of the listing, and nothing more.
  [`GET ${DOC}`]: { twin: 'wb_document_list' },
  [`DELETE ${DOC}`]: { twin: 'wb_workspace_edit' },
  [`GET ${WS}/search`]: { twin: 'wb_document_search' },
  [`GET ${DOC}/okf`]: { twin: 'wb_document_get' },
  [`GET ${WS}/document-tags`]: {
    noTwin:
      'the document browser’s filter chips; answers the tags documents carry and the tag and stencil library documents, which is content',
    scopes: ['canvas:read'],
  },
  [`GET ${DOC}/backlinks`]: {
    noTwin: 'the connections panel; answers a context excerpt of each referring document',
    scopes: ['canvas:read'],
  },
  [`PUT ${WS}/tag-library`]: { twin: 'wb_facet_set' },
  [`POST ${DOC}/linkify-mentions`]: {
    noTwin: 'the connections panel’s Link action; rewrites a document’s body and text nodes',
    scopes: ['canvas:write'],
  },
}

const concrete = (path: string) =>
  path.replace(':workspaceId', 'ws1').replace(':documentId', '01ARZ3NDEKTSV4RRFFQ69G5FAV')

const mounted = createServer(resolveServerDeps(createContainer(storeMemoryModule)))
  .app.routes.filter((route) => route.path.startsWith('/api/v1/') && !route.path.endsWith('*'))
  .map((route) => `${route.method} ${route.path}`)

describe('/api/v1 routes ask the scopes their MCP twins ask', () => {
  it('reads the mounted v1 surface, not an empty one', () => {
    expect(mounted.length).toBeGreaterThanOrEqual(9)
  })

  it('has an entry for every mounted v1 route, and none for a route not mounted', () => {
    expect([...new Set(mounted)].sort()).toEqual(Object.keys(V1_ROUTE_SCOPES).sort())
  })

  it.for(Object.entries(V1_ROUTE_SCOPES))('%s', ([route, entry]) => {
    const [method, path] = route.split(' ') as [string, string]
    if ('noTwin' in entry) expect(entry.noTwin.length).toBeGreaterThan(20)
    const expected = 'twin' in entry ? MCP_TOOL_SCOPES[entry.twin] : entry.scopes
    expect(expected, 'the named twin has no MCP_TOOL_SCOPES entry').toBeDefined()
    expect(resolveApiRouteScope(method, concrete(path))).toEqual({
      kind: 'scoped',
      scopes: expected,
    })
  })
})

describe('a create carrying a body asks the same scopes on both surfaces', () => {
  const required = (scopes: readonly AuthScope[]) => [...new Set(scopes)].sort()
  const mcpCreate = (op: Record<string, unknown>) =>
    required([
      ...(MCP_TOOL_SCOPES.wb_workspace_edit ?? []),
      ...(MCP_TOOL_INPUT_SCOPES.wb_workspace_edit?.({ ops: [op] }) ?? []),
    ])

  const creates: ReadonlyArray<readonly [string, { kind: string; markdown?: string }]> = [
    ['with markdown', { kind: 'markdown', markdown: '# Plan' }],
    ['with no body', { kind: 'markdown' }],
    ['spatial', { kind: 'spatial' }],
  ]
  it.for(creates)('%s', ([, body]) => {
    const v1 = required(createBodyScopes(body))
    expect(mcpCreate({ op: 'document.create', path: 'plan', ...body })).toEqual(v1)
  })

  it('a body is content: canvas:write', () => {
    expect(createBodyScopes({ markdown: '# Plan' })).toContain('canvas:write')
    expect(createBodyScopes({})).not.toContain('canvas:write')
    expect(createBodyScopes({ markdown: '' })).not.toContain('canvas:write')
  })
})
