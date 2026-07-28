import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it, vi } from 'vitest'
import { InMemoryBlobStore } from '../store/inmemory/in-memory-blob-store.js'
import { InMemoryCanvasDocStore } from '../store/inmemory/in-memory-canvas-doc-store.js'
import { InMemoryWorkspaceIndex } from '../store/inmemory/in-memory-workspace-index.js'
import { registerOpenCanvasTools } from './opencanvas-tools.js'

function fakeServer() {
  const registerTool = vi.fn()
  return { server: { registerTool }, registerTool } as unknown as McpServer
}

function fakeDeps() {
  return {
    canvasDocStore: new InMemoryCanvasDocStore(),
    workspaceIndex: new InMemoryWorkspaceIndex(),
    blobStore: new InMemoryBlobStore(),
  }
}

describe('registerOpenCanvasTools', () => {
  it('registers version_save, version_list, and version_restore via the server-core wiring', () => {
    const server = fakeServer()
    registerOpenCanvasTools(server, fakeDeps())

    const registerToolMock = vi.mocked(server.registerTool)
    const names = registerToolMock.mock.calls.map((call) => call[0])
    expect(names).toContain('version_save')
    expect(names).toContain('version_list')
    expect(names).toContain('version_restore')
  })
})
