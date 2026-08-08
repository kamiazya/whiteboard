import type { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../log.js'
import { InMemoryBlobStore } from '../store/inmemory/in-memory-blob-store.js'
import { InMemoryCanvasDocStore } from '../store/inmemory/in-memory-canvas-doc-store.js'
import { InMemoryWorkspaceIndex } from '../store/inmemory/in-memory-workspace-index.js'
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

  it("surfaces a server-core fail-open reindex error through this composition root's logger", async () => {
    // reindexWorkspace's applyRows failure is server-core's canonical
    // "never throws, but logs" path (see reindex.ts). Without the module-
    // scope setServerCoreLogSink wiring in opencanvas-tools.ts, this record
    // would be silently dropped instead of reaching an operator.
    const server = fakeServer()
    const deps = fakeDeps()
    registerOpenCanvasTools(server, deps)

    const registerToolMock = vi.mocked(server.registerTool)
    const findHandler = (name: string) => {
      const call = registerToolMock.mock.calls.find((c) => c[0] === name)
      if (!call) throw new Error(`${name} was not registered`)
      return call[2] as (
        args: unknown,
        extra: unknown,
      ) => Promise<{ structuredContent: Record<string, unknown> }>
    }

    const created = await findHandler('wb_canvas_create')(
      { workspaceId: 'ws-1', segment: 'canvas-a', createWorkspace: true },
      { requestId: 'req-0' },
    )
    const canvasId = created.structuredContent.canvasId as string

    vi.spyOn(deps.workspaceIndex, 'applyRows').mockRejectedValueOnce(
      new Error('index store unavailable'),
    )

    const capture = captureLogsForTests('debug')
    try {
      await findHandler('facet_set')(
        { workspaceId: 'ws-1', canvasId, facets: {} },
        { requestId: 'req-1' },
      )
    } finally {
      capture.restore()
    }

    expect(capture.records).toContainEqual(
      expect.objectContaining({
        scope: 'reindex',
        level: 'error',
        msg: 'failed to apply workspace index rows',
        data: expect.objectContaining({ workspaceId: 'ws-1' }),
      }),
    )
  })
})
