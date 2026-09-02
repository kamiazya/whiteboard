import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// The widget HTML fixture lives in a per-test temp dir, injected via
// resetWidgetHtmlCacheForTests — never the real WIDGET_HTML_PATH, whose
// build output a test must not delete out from under a same-machine
// smoke run.
import {
  CANVAS_VIEW_RESOURCE_URI,
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
  registerMcpAppsExtension,
  resetWidgetHtmlCacheForTests,
} from './mcp-apps.js'

function fakeServer() {
  const registerResource = vi.fn()
  const registerCapabilities = vi.fn()
  return {
    registerResource,
    server: { registerCapabilities },
  } as any
}

describe('registerMcpAppsExtension', () => {
  let fixtureDir: string
  let fixtureHtmlPath: string

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'mcp-apps-widget-'))
    fixtureHtmlPath = join(fixtureDir, 'canvas-viewer.html')
    resetWidgetHtmlCacheForTests(fixtureHtmlPath)
  })

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
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

  it('reads the widget HTML from the widget path on resources/read', async () => {
    writeFileSync(fixtureHtmlPath, '<html><body>widget</body></html>', 'utf-8')

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

  it('throws a generic error (never the absolute install path) when the widget HTML is missing', async () => {
    const server = fakeServer()
    registerMcpAppsExtension(server)
    const readCallback = server.registerResource.mock.calls[0][3]

    await expect(readCallback()).rejects.toThrow('widget asset unavailable')
    // The MCP SDK surfaces a rejected resources/read error's message
    // verbatim to the calling client, so the raw fs ENOENT — which embeds
    // the widget's absolute path — must never be the thrown error itself.
    await expect(readCallback()).rejects.not.toThrow(fixtureHtmlPath)
  })
})
