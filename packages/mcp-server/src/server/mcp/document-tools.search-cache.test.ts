// `/mcp` builds a FRESH McpServer per request (routes/mcp.ts), so whatever
// `registerDocumentTools` builds is request-scoped unless it is held by the
// deps. The search vectors and the content-facts behind them promise to be
// kept between searches; this measures that over the same per-request
// construction the endpoint performs, with a counting embedder and a
// counting store standing in for the two expensive halves.
import { join } from 'node:path'
import type { Embedder, ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-mcp-search-cache-')

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return join(tmp.dir, 'data')
  },
  getDataDir: () => join(tmp.dir, 'data'),
  get DIST_WEB_APP_DIR() {
    return join(tmp.dir, 'web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

const { createMcpServer } = await import('./index.js')
const { resolveTestServerDeps } = await import('../routes/_test-helpers.js')

const NOTES = ['alpha', 'bravo', 'charlie', 'delta'] as const

function countingEmbedder() {
  // Only the document role is the cost the cache exists to avoid; a query is
  // embedded on every search by definition.
  const embedded: string[] = []
  const embedder: Embedder = {
    id: 'counting@v1',
    dimensions: 2,
    async embed(texts, role) {
      if (role === 'document') embedded.push(...texts)
      return texts.map(() => new Float32Array([1, 0]))
    },
  }
  return { embedder, embedded }
}

/** What the daemon does per `/mcp` request: a new server over the same deps. */
async function callOnFreshServer(deps: ServerDeps, name: string, args: Record<string, unknown>) {
  const server = await createMcpServer(deps)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'search-cache', version: '0.0.0' })
  await client.connect(clientSide)
  try {
    return await client.callTool({ name, arguments: args })
  } finally {
    await client.close()
  }
}

describe('wb_document_search over per-request MCP servers', () => {
  beforeEach(async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tmp.dir, 'data'), { recursive: true })
  })

  it('embeds and reloads nothing on the second search when no document changed', async () => {
    const { embedder, embedded } = countingEmbedder()
    const loads = { count: 0 }
    const base = await resolveTestServerDeps(join(tmp.dir, 'data'))
    const deps: ServerDeps = {
      ...base,
      embedder,
      documentStore: new Proxy(base.documentStore, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver)
          if (key === 'loadSnapshot' && typeof value === 'function') {
            return (...args: unknown[]) => {
              loads.count += 1
              return value.apply(target, args)
            }
          }
          return typeof value === 'function' ? value.bind(target) : value
        },
      }),
    }

    const created = await callOnFreshServer(deps, 'wb_workspace_edit', {
      workspaceId: 'search-cache',
      createWorkspace: true,
      ops: NOTES.map((name) => ({
        op: 'document.create',
        path: name,
        kind: 'markdown',
        markdown: `---\ntype: note\n---\n${name} is a word`,
      })),
    })
    const workspaceId = (created.structuredContent as { workspaceId: string }).workspaceId

    loads.count = 0
    const search = () =>
      callOnFreshServer(deps, 'wb_document_search', { workspaceId, query: 'word' })
    const first = await search()
    expect(first.isError).not.toBe(true)
    const afterFirst = { embedded: embedded.length, loads: loads.count }
    expect(afterFirst.embedded).toBe(NOTES.length)

    const second = await search()
    expect(second.isError).not.toBe(true)
    const secondRun = {
      embedded: embedded.length - afterFirst.embedded,
      loads: loads.count - afterFirst.loads,
    }
    process.stdout.write(
      `search-cache: first search embedded ${afterFirst.embedded} documents / ${afterFirst.loads} snapshot loads; second embedded ${secondRun.embedded} / ${secondRun.loads}\n`,
    )
    expect(secondRun).toEqual({ embedded: 0, loads: 0 })
  })
})
