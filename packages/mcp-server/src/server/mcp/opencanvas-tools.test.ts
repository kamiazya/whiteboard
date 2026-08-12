import { getLogger as getServerCoreLogger } from '@kamiazya/whiteboard-server-core'
import type { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../log.js'
import { InMemoryBlobStore } from '../store/inmemory/in-memory-blob-store.js'
import { InMemoryCanvasDocStore } from '../store/inmemory/in-memory-canvas-doc-store.js'
// Side-effect import: registering these tools also installs the server-core
// log-sink wiring at module scope (see opencanvas-tools.ts).
import { registerOpenCanvasTools } from './opencanvas-tools.js'

function fakeServer() {
  const registerTool = vi.fn()
  return { server: { registerTool }, registerTool } as unknown as McpServer
}

function fakeDeps() {
  return {
    canvasDocStore: new InMemoryCanvasDocStore(),
    blobStore: new InMemoryBlobStore(),
  }
}

describe('registerOpenCanvasTools', () => {
  it('registers wb_version_save, wb_version_list, and wb_version_restore via the server-core wiring', () => {
    const server = fakeServer()
    registerOpenCanvasTools(server, fakeDeps())

    const registerToolMock = vi.mocked(server.registerTool)
    const names = registerToolMock.mock.calls.map((call) => call[0])
    expect(names).toContain('wb_version_save')
    expect(names).toContain('wb_version_list')
    expect(names).toContain('wb_version_restore')
  })

  it("forwards a server-core log record to this composition root's logger", () => {
    // Registering the tools (via the side-effect import above) installs
    // the module-scope setServerCoreLogSink wiring in opencanvas-tools.ts.
    // Without it, any record a server-core call site logs (via its own
    // injectable getLogger) would be silently dropped instead of reaching
    // an operator — see server-core/src/log.ts's doc comment on why this
    // shared layer cannot reach for mcp-server's pino logger directly.
    const server = fakeServer()
    registerOpenCanvasTools(server, fakeDeps())

    const capture = captureLogsForTests('debug')
    try {
      getServerCoreLogger('some-server-core-scope').error('something failed', {
        workspaceId: 'ws-1',
      })
    } finally {
      capture.restore()
    }

    expect(capture.records).toContainEqual(
      expect.objectContaining({
        scope: 'some-server-core-scope',
        level: 'error',
        msg: 'something failed',
        data: expect.objectContaining({ workspaceId: 'ws-1' }),
      }),
    )
  })
})
