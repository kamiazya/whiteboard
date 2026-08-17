import { getLogger as getServerCoreLogger } from '@kamiazya/whiteboard-server-core'
import type { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../log.js'
import { InMemoryBlobStore } from '../store/inmemory/in-memory-blob-store.js'
import { InMemoryDocumentStore } from '../store/inmemory/in-memory-document-store.js'
import { registerDocumentTools } from './document-tools.js'
// Side-effect import: registering these tools also installs the server-core
// log-sink wiring at module scope (see document-tools.ts).
import { CANVAS_VIEW_RESOURCE_URI, RESOURCE_URI_META_KEY } from './mcp-apps.js'
import { UI_LINKED_TOOLS } from './mcp-smoke-coverage.js'

function fakeServer() {
  const registerTool = vi.fn()
  return { server: { registerTool }, registerTool } as unknown as McpServer
}

function fakeDeps() {
  return {
    documentStore: new InMemoryDocumentStore(),
    blobStore: new InMemoryBlobStore(),
  }
}

describe('registerDocumentTools', () => {
  it('registers wb_version_save, wb_version_list, and wb_version_restore via the server-core wiring', () => {
    const server = fakeServer()
    registerDocumentTools(server, fakeDeps())

    const registerToolMock = vi.mocked(server.registerTool)
    const names = registerToolMock.mock.calls.map((call) => call[0])
    expect(names).toContain('wb_version_save')
    expect(names).toContain('wb_version_list')
    expect(names).toContain('wb_version_restore')
  })

  it.each(UI_LINKED_TOOLS)('%s is registered with the MCP Apps widget linkage', (name) => {
    // Without `_meta.ui.resourceUri` the widget resource stays registered
    // and unreachable — a host renders the tool's JSON instead of the
    // canvas. That was this repo's actual state: the resource, the
    // capability and the widget bundle all shipped, and no tool linked
    // them. UI_LINKED_TOOLS is only a claim until this asserts it.
    const server = fakeServer()
    registerDocumentTools(server, fakeDeps())

    const call = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === name)
    expect(call, `${name} is not registered at all`).toBeDefined()
    const meta = (call?.[1] as { _meta?: Record<string, unknown> })?._meta
    expect(meta?.ui).toEqual({ resourceUri: CANVAS_VIEW_RESOURCE_URI })
    // The wrapper mirrors it into the deprecated key for older hosts.
    expect(meta?.[RESOURCE_URI_META_KEY]).toBe(CANVAS_VIEW_RESOURCE_URI)
  })

  it('registers no UI linkage on a data-plane tool', () => {
    // The mirror-into-legacy-key branch runs for every tool, so a bug there
    // could stamp the linkage onto tools that must not render as a widget.
    const server = fakeServer()
    registerDocumentTools(server, fakeDeps())
    const dataPlane = vi
      .mocked(server.registerTool)
      .mock.calls.filter((c) => !UI_LINKED_TOOLS.includes(c[0] as never))
    expect(dataPlane.length).toBeGreaterThan(0)
    for (const call of dataPlane) {
      const meta = (call[1] as { _meta?: Record<string, unknown> })?._meta
      expect(meta?.ui, `${call[0]} carries a UI linkage it should not`).toBeUndefined()
    }
  })

  it("forwards a server-core log record to this composition root's logger", () => {
    // Registering the tools (via the side-effect import above) installs
    // the module-scope setServerCoreLogSink wiring in document-tools.ts.
    // Without it, any record a server-core call site logs (via its own
    // injectable getLogger) would be silently dropped instead of reaching
    // an operator — see server-core/src/log.ts's doc comment on why this
    // shared layer cannot reach for mcp-server's pino logger directly.
    const server = fakeServer()
    registerDocumentTools(server, fakeDeps())

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
