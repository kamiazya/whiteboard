import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Widget HTML fixture lives under WHITEBOARD_ROOT/dist/widget in this test
// run — module-scope caching means each test must reset the cache and
// remove any file it wrote so runs don't leak into each other.
const {
  registerMcpAppsExtension,
  resetWidgetHtmlCacheForTests,
  WIDGET_HTML_PATH,
  CANVAS_VIEW_RESOURCE_URI,
  RESOURCE_MIME_TYPE,
  EXTENSION_ID,
} = await import('./mcp-apps.js')

function fakeServer() {
  const registerResource = vi.fn()
  const registerCapabilities = vi.fn()
  return {
    registerResource,
    server: { registerCapabilities },
    // biome-ignore lint/suspicious/noExplicitAny: minimal structural fake, cast at call sites
  } as any
}

describe('registerMcpAppsExtension', () => {
  beforeEach(() => {
    resetWidgetHtmlCacheForTests()
  })

  afterEach(() => {
    rmSync(WIDGET_HTML_PATH, { force: true })
    resetWidgetHtmlCacheForTests()
  })

  it('declares the io.modelcontextprotocol/ui extension capability', () => {
    expect(EXTENSION_ID).toBe('io.modelcontextprotocol/ui')
    const server = fakeServer()
    registerMcpAppsExtension(server)
    expect(server.server.registerCapabilities).toHaveBeenCalledWith({
      extensions: { [EXTENSION_ID]: {} },
    })
  })

  it('registers the ui://whiteboard/canvas-view resource with the mcp-app mimeType', () => {
    const server = fakeServer()
    registerMcpAppsExtension(server)
    expect(server.registerResource).toHaveBeenCalledWith(
      'whiteboard-canvas-view',
      CANVAS_VIEW_RESOURCE_URI,
      expect.objectContaining({ mimeType: RESOURCE_MIME_TYPE }),
      expect.any(Function),
    )
    expect(RESOURCE_MIME_TYPE).toBe('text/html;profile=mcp-app')
  })

  it('reads the widget HTML from WIDGET_HTML_PATH on resources/read', async () => {
    mkdirSync(dirname(WIDGET_HTML_PATH), { recursive: true })
    writeFileSync(WIDGET_HTML_PATH, '<html><body>widget</body></html>', 'utf-8')

    const server = fakeServer()
    registerMcpAppsExtension(server)
    const readCallback = server.registerResource.mock.calls[0][3]
    const result = await readCallback()

    expect(result.contents[0]).toEqual({
      uri: CANVAS_VIEW_RESOURCE_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: '<html><body>widget</body></html>',
    })
  })

  it('throws and logs loudly when the widget HTML is missing', async () => {
    const server = fakeServer()
    registerMcpAppsExtension(server)
    const readCallback = server.registerResource.mock.calls[0][3]

    await expect(readCallback()).rejects.toThrow()
  })
})
