import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_APP_DIR: '/tmp/whiteboard/dist/app',
}))

// Mock ws.ts so each test can control getClientCount and sendExportRequest.
type MockedExportOptions = {
  padding?: number
  scale?: number
  minFontPx?: number
  frameId?: string
}
const mockGetClientCount = vi.fn<(sessionId: string, slug: string) => number>()
const mockSendExportRequest = vi.fn<
  (sessionId: string, slug: string, requestId: string, options?: MockedExportOptions) => void
>()

vi.mock('./ws.js', () => ({
  getClientCount: (sessionId: string, slug: string) => mockGetClientCount(sessionId, slug),
  sendExportRequest: (
    sessionId: string,
    slug: string,
    requestId: string,
    options?: MockedExportOptions,
  ) => mockSendExportRequest(sessionId, slug, requestId, options),
}))

const { createExportRouter, resolveExportRequest } = await import('./export.js')

function makeApp(options: { timeoutMs?: number } = {}) {
  const app = new Hono()
  app.route('/', createExportRouter(options))
  return app
}

describe('POST /api/canvas/:sessionId/:slug/export - error handling', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-export-test-'))
    mockGetClientCount.mockReset()
    mockSendExportRequest.mockReset()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns 503 immediately when there are no WS clients', async () => {
    mockGetClientCount.mockReturnValue(0)
    const app = makeApp()

    const start = Date.now()
    const res = await app.request('/api/canvas/s1/canvas-a/export', { method: 'POST' })
    const elapsed = Date.now() - start

    expect(res.status).toBe(503)
    // Respond immediately instead of waiting for the normal timeout window.
    expect(elapsed).toBeLessThan(500)
    expect(mockSendExportRequest).not.toHaveBeenCalled()
  })

  it('includes a canvas_open hint in the zero-client error JSON', async () => {
    mockGetClientCount.mockReturnValue(0)
    const app = makeApp()
    const res = await app.request('/api/canvas/s1/canvas-a/export', { method: 'POST' })
    const body = (await res.json()) as { error: string; message: string; hint?: string }
    expect(body.error).toBe('no_client')
    expect(body.message.toLowerCase()).toContain('no browser')
    expect(body.hint).toContain('canvas_open')
  })

  it('returns 504 and a timeout error when a WS client does not respond', async () => {
    mockGetClientCount.mockReturnValue(1)
    // Use a short real timeout instead of fake timers because
    // vi.advanceTimersByTimeAsync cannot advance setTimeout inside Hono async context.
    const app = makeApp({ timeoutMs: 50 })

    const res = await app.request('/api/canvas/s1/canvas-a/export', { method: 'POST' })

    expect(res.status).toBe(504)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('timeout')
    expect(body.message).toMatch(/0s|timed out/i)
  })

  it('passes padding through to sendExportRequest options', async () => {
    mockGetClientCount.mockReturnValue(1)
    mockSendExportRequest.mockImplementation((_sid, _slug, requestId) => {
      queueMicrotask(() => {
        resolveExportRequest(
          requestId,
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        )
      })
    })
    const app = makeApp()

    const res = await app.request('/api/canvas/s1/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 48 }),
    })
    expect(res.status).toBe(200)
    expect(mockSendExportRequest).toHaveBeenCalledWith(
      's1',
      'canvas-a',
      expect.any(String),
      { padding: 48 },
    )
  })

  it('leaves options undefined when the body is missing or padding is omitted', async () => {
    mockGetClientCount.mockReturnValue(1)
    mockSendExportRequest.mockImplementation((_sid, _slug, requestId) => {
      queueMicrotask(() => {
        resolveExportRequest(
          requestId,
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        )
      })
    })
    const app = makeApp()

    const res = await app.request('/api/canvas/s1/canvas-a/export', { method: 'POST' })
    expect(res.status).toBe(200)
    // options should remain undefined here.
    const call = mockSendExportRequest.mock.calls[0]
    expect(call[0]).toBe('s1')
    expect(call[1]).toBe('canvas-a')
    expect(call[3]?.padding).toBeUndefined()
  })

  // Route-level responsibility here is just to extract scale / minFontPx from
  // the body and forward them to sendExportRequest. Browser-side
  // useWhiteboardSync handles exportScale injection and minFontPx adjustment.
  it('passes scale and minFontPx through to sendExportRequest options', async () => {
    mockGetClientCount.mockReturnValue(1)
    mockSendExportRequest.mockImplementation((_sid, _slug, requestId) => {
      queueMicrotask(() => {
        resolveExportRequest(
          requestId,
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        )
      })
    })
    const app = makeApp()

    const res = await app.request('/api/canvas/s1/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 32, scale: 2, minFontPx: 14 }),
    })
    expect(res.status).toBe(200)
    expect(mockSendExportRequest).toHaveBeenCalledWith('s1', 'canvas-a', expect.any(String), {
      padding: 32,
      scale: 2,
      minFontPx: 14,
    })
  })

  it('passes frameId through to sendExportRequest options', async () => {
    mockGetClientCount.mockReturnValue(1)
    mockSendExportRequest.mockImplementation((_sid, _slug, requestId) => {
      queueMicrotask(() => {
        resolveExportRequest(
          requestId,
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        )
      })
    })
    const app = makeApp()

    const res = await app.request('/api/canvas/s1/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frameId: 'frame-abc', padding: 24 }),
    })
    expect(res.status).toBe(200)
    expect(mockSendExportRequest).toHaveBeenCalledWith('s1', 'canvas-a', expect.any(String), {
      frameId: 'frame-abc',
      padding: 24,
    })
  })

  it('leaves the other options undefined when only frameId is provided', async () => {
    mockGetClientCount.mockReturnValue(1)
    mockSendExportRequest.mockImplementation((_sid, _slug, requestId) => {
      queueMicrotask(() => {
        resolveExportRequest(
          requestId,
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        )
      })
    })
    const app = makeApp()

    await app.request('/api/canvas/s1/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frameId: 'frame-xyz' }),
    })
    const call = mockSendExportRequest.mock.calls[0]
    expect(call[3]).toEqual({ frameId: 'frame-xyz' })
    expect(call[3]?.padding).toBeUndefined()
    expect(call[3]?.scale).toBeUndefined()
    expect(call[3]?.minFontPx).toBeUndefined()
  })

  it('does not include padding in options when only scale is provided', async () => {
    mockGetClientCount.mockReturnValue(1)
    mockSendExportRequest.mockImplementation((_sid, _slug, requestId) => {
      queueMicrotask(() => {
        resolveExportRequest(
          requestId,
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        )
      })
    })
    const app = makeApp()

    await app.request('/api/canvas/s1/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale: 3 }),
    })
    const call = mockSendExportRequest.mock.calls[0]
    expect(call[3]).toEqual({ scale: 3 })
    expect(call[3]?.padding).toBeUndefined()
    expect(call[3]?.minFontPx).toBeUndefined()
  })

  it('returns 200 and filePath when a WS client sends export_response', async () => {
    mockGetClientCount.mockReturnValue(1)
    // Capture requestId from sendExportRequest and resolve it through resolveExportRequest.
    mockSendExportRequest.mockImplementation((_sid, _slug, requestId) => {
      // 1x1 transparent PNG base64
      queueMicrotask(() => {
        resolveExportRequest(
          requestId,
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        )
      })
    })
    const app = makeApp()

    const res = await app.request('/api/canvas/s1/canvas-a/export', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { filePath: string }
    expect(body.filePath).toMatch(/canvas-a-.*\.png$/)
  })

  // Nested canvas paths such as architecture/overview should create parent
  // directories recursively instead of failing with ENOENT.
  it('writes nested slash-containing slugs without ENOENT', async () => {
    mockGetClientCount.mockReturnValue(1)
    mockSendExportRequest.mockImplementation((_sid, _slug, requestId) => {
      queueMicrotask(() => {
        resolveExportRequest(
          requestId,
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        )
      })
    })
    const app = makeApp()

    // MCP sends the slug through encodeURIComponent, so it arrives as one segment with `%2F`.
    const res = await app.request('/api/canvas/s1/architecture%2Foverview/export', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { filePath: string }
    expect(body.filePath).toMatch(/exports\/architecture\/overview-.*\.png$/)
  })

  it('returns 400 for invalid sessionId or slug without reaching WS', async () => {
    mockGetClientCount.mockReturnValue(1)
    const app = makeApp()

    const badSession = await app.request('/api/canvas/bad.sid/canvas-a/export', {
      method: 'POST',
    })
    expect(badSession.status).toBe(400)

    const badSlug = await app.request('/api/canvas/s1/bad.slug/export', {
      method: 'POST',
    })
    expect(badSlug.status).toBe(400)
    expect(mockSendExportRequest).not.toHaveBeenCalled()
  })

  it('writes the PNG to an explicit absolute outputPath when provided', async () => {
    mockGetClientCount.mockReturnValue(1)
    mockSendExportRequest.mockImplementation((_sid, _slug, requestId) => {
      queueMicrotask(() => {
        resolveExportRequest(
          requestId,
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        )
      })
    })
    const app = makeApp()
    const outputPath = join(tempDir, 'subdir', 'custom.excalidraw.png')

    const res = await app.request('/api/canvas/s1/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { filePath: string }
    expect(body.filePath).toBe(outputPath)
    const bytes = await readFile(outputPath)
    // PNG signature
    expect(bytes[0]).toBe(0x89)
  })

  it('rejects a relative PNG outputPath with 400 invalid_output_path', async () => {
    mockGetClientCount.mockReturnValue(1)
    const app = makeApp()
    const res = await app.request('/api/canvas/s1/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath: 'relative/out.png' }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_output_path' })
    expect(mockSendExportRequest).not.toHaveBeenCalled()
  })

  it('refuses to overwrite an existing PNG by default and returns 409', async () => {
    mockGetClientCount.mockReturnValue(1)
    mockSendExportRequest.mockImplementation((_sid, _slug, requestId) => {
      queueMicrotask(() => {
        resolveExportRequest(
          requestId,
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        )
      })
    })
    const app = makeApp()
    const outputPath = join(tempDir, 'pre-existing.png')
    await writeFile(outputPath, 'OLD')

    const res = await app.request('/api/canvas/s1/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath }),
    })
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({ error: 'output_exists' })
    // Still the old contents.
    await expect(readFile(outputPath, 'utf-8')).resolves.toBe('OLD')
  })

  it('overwrites an existing PNG when overwrite=true', async () => {
    mockGetClientCount.mockReturnValue(1)
    mockSendExportRequest.mockImplementation((_sid, _slug, requestId) => {
      queueMicrotask(() => {
        resolveExportRequest(
          requestId,
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        )
      })
    })
    const app = makeApp()
    const outputPath = join(tempDir, 'replace.png')
    await writeFile(outputPath, 'OLD')

    const res = await app.request('/api/canvas/s1/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath, overwrite: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { filePath: string }
    expect(body.filePath).toBe(outputPath)
    const bytes = await readFile(outputPath)
    expect(bytes[0]).toBe(0x89)
  })
})
