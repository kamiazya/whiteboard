import type { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { RESOURCE_URI_META_KEY } from './mcp-apps.js'
import { registerToolWithAnnotations } from './tool-support.js'

function fakeServer() {
  const registerTool = vi.fn()
  return { server: { registerTool }, registerTool } as unknown as McpServer
}

describe('registerToolWithAnnotations', () => {
  it('mirrors _meta.ui.resourceUri into the deprecated ui/resourceUri key for older hosts', () => {
    const server = fakeServer()
    registerToolWithAnnotations(
      server,
      'canvas_view',
      {
        outputSchema: z.object({ ok: z.boolean() }),
        _meta: { ui: { resourceUri: 'ui://whiteboard/canvas-view' } },
      },
      async () => ({ structuredContent: { ok: true }, content: [] }),
    )

    const registerToolMock = vi.mocked(server.registerTool)
    const config = registerToolMock.mock.calls[0]?.[1] as { _meta?: Record<string, unknown> }
    expect(config._meta).toEqual({
      ui: { resourceUri: 'ui://whiteboard/canvas-view' },
      [RESOURCE_URI_META_KEY]: 'ui://whiteboard/canvas-view',
    })
  })

  it('leaves _meta untouched for tools without MCP Apps UI linkage', () => {
    const server = fakeServer()
    registerToolWithAnnotations(
      server,
      'canvas_open',
      { outputSchema: z.object({ ok: z.boolean() }) },
      async () => ({ structuredContent: { ok: true }, content: [] }),
    )

    const registerToolMock = vi.mocked(server.registerTool)
    const config = registerToolMock.mock.calls[0]?.[1] as { _meta?: Record<string, unknown> }
    expect(config._meta).toBeUndefined()
  })
})
