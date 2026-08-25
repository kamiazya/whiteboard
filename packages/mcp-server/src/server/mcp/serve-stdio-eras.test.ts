// The stdio entrypoint must serve BOTH protocol eras: a hand-constructed
// `server.connect(StdioServerTransport)` speaks only the 2025-era protocol,
// so main() goes through `serveStdio(factory)` — the opening exchange pins
// the connection's era. These tests drive our real `createMcpServer`
// factory through `serveStdio` over linked in-memory transports, one
// connection per era.
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { afterEach, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-serve-stdio-test-')

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
const { clearWorkspaceIdCache } = await import('../current-workspace.js')

afterEach(() => {
  clearWorkspaceIdCache()
})

it('serveStdio serves a legacy (2025) client from the createMcpServer factory', async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const handle = serveStdio(() => createMcpServer(), { transport: serverSide })
  const client = new Client({ name: 'legacy-stdio-client', version: '1.0.0' })
  try {
    await client.connect(clientSide)
    const tools = await client.listTools()
    expect(tools.tools.some((tool) => tool.name === 'wb_document_create')).toBe(true)
  } finally {
    await client.close().catch(() => {})
    await handle.close().catch(() => {})
  }
})

it('serveStdio serves a modern-pinned (2026-07-28) client from the same factory', async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const handle = serveStdio(() => createMcpServer(), { transport: serverSide })
  const client = new Client(
    { name: 'modern-stdio-client', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  )
  try {
    await client.connect(clientSide)
    expect(client.getProtocolEra()).toBe('modern')
    const tools = await client.listTools()
    expect(tools.tools.some((tool) => tool.name === 'wb_document_create')).toBe(true)
  } finally {
    await client.close().catch(() => {})
    await handle.close().catch(() => {})
  }
})
