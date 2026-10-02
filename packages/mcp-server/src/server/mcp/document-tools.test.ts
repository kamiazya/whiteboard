import {
  getLogger as getServerCoreLogger,
  setLogSink as setServerCoreLogSink,
} from '@kamiazya/whiteboard-server-core'
import type { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../../di/container.js'
import { storeMemoryModule } from '../../shared/test-utils/store-memory.module.js'
import { captureLogsForTests } from '../log.js'
import { registerDocumentTools } from './document-tools.js'
import { CANVAS_VIEW_RESOURCE_URI, RESOURCE_URI_META_KEY } from './mcp-apps.js'
import { UI_LINKED_TOOLS } from './mcp-smoke-coverage.js'

function fakeServer() {
  const registerTool = vi.fn()
  return { server: { registerTool }, registerTool } as unknown as McpServer
}

/** The in-memory composition every route and tool test over a whole `ServerDeps` shares. */
const fakeDeps = () => resolveServerDeps(createContainer(storeMemoryModule))

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

  /**
   * The three standalone document-CRUD tools are RETIRED: `wb_workspace_edit`
   * carries `document.create` / `document.set` / `document.delete` as ops, and
   * two ways to do one thing is a tool table an agent has to read twice.
   *
   * The operations themselves are untouched — `wbDocumentCreate` and friends
   * still back the batch's ops and the `/api/v1` routes. What is gone is the
   * second, single-subject FRONT DOOR onto them.
   */
  it.each([
    'wb_document_create',
    'wb_document_set',
    'wb_document_delete',
  ])('no longer registers %s', (name) => {
    const server = fakeServer()
    registerDocumentTools(server, fakeDeps())

    const names = vi.mocked(server.registerTool).mock.calls.map((call) => call[0])
    expect(names).not.toContain(name)
    expect(names).toContain('wb_workspace_edit')
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

  it('does not arm the server-core log sink as a side effect of being loaded', () => {
    // Arming is each root's explicit startup act (`routeServerCoreLogs`); a
    // sink installed by importing the tool registry would be armed or not
    // depending on which modules a root happened to load.
    setServerCoreLogSink(() => {})
    registerDocumentTools(fakeServer(), fakeDeps())

    const capture = captureLogsForTests('debug')
    try {
      getServerCoreLogger('some-server-core-scope').error('something failed')
    } finally {
      capture.restore()
    }

    expect(capture.records).toEqual([])
  })
})
