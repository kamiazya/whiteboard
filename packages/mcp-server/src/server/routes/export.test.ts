import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
}))

// Mock ws.ts so each test can control getClientCount and sendExportRequest.
type MockedExportOptions = {
  padding?: number
  scale?: number
  minFontPx?: number
  frameId?: string
  theme?: 'light' | 'dark'
}
const mockGetClientCount = vi.fn<(workspaceId: string, slug: string) => number>()
const mockSendExportRequest =
  vi.fn<
    (workspaceId: string, slug: string, requestId: string, options?: MockedExportOptions) => void
  >()

vi.mock('./ws.js', () => ({
  getClientCount: (workspaceId: string, slug: string) => mockGetClientCount(workspaceId, slug),
  sendExportRequest: (
    workspaceId: string,
    slug: string,
    requestId: string,
    options?: MockedExportOptions,
  ) => mockSendExportRequest(workspaceId, slug, requestId, options),
}))

// Stub the headless renderer so route tests do not pull jsdom/canvas/resvg in
// every run. The fallback path just needs to return a valid PNG buffer for the
// route to write to disk.
type MockHeadlessArgs = {
  workspaceId: string
  slug: string
  options?: {
    padding?: number
    scale?: number
    frameId?: string
    minFontPx?: number
    theme?: 'light' | 'dark'
  }
}
const mockExportCanvasHeadless =
  vi.fn<(args: MockHeadlessArgs) => Promise<{ png: Buffer; width: number; height: number }>>()

vi.mock('../export/headless-export.js', () => ({
  exportCanvasHeadless: (args: MockHeadlessArgs) => mockExportCanvasHeadless(args),
}))

// Default canvasExists to true so existing tests that already construct a
// route + mock the headless renderer keep passing without each having to
// stub the metadata-DB lookup. Missing-canvas tests opt out by overriding
// the mock per-case.
const mockCanvasExists = vi.fn<(workspaceId: string, slug: string) => Promise<boolean>>(
  async () => true,
)
vi.mock('../store/canvas-store.js', () => ({
  canvasExists: (workspaceId: string, slug: string) => mockCanvasExists(workspaceId, slug),
}))

const { createExportRouter, resolveExportRequest } = await import('./export.js')

function makeApp(options: { timeoutMs?: number } = {}) {
  const app = new Hono()
  app.route('/', createExportRouter(options))
  return app
}

describe('POST /api/canvas/:workspaceId/:slug/export - error handling', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-export-test-'))
    mockGetClientCount.mockReset()
    mockSendExportRequest.mockReset()
    mockExportCanvasHeadless.mockReset()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('falls back to headless rendering when no WS clients are connected', async () => {
    mockGetClientCount.mockReturnValue(0)
    const fakePng = Buffer.from('fake-png-bytes')
    mockExportCanvasHeadless.mockResolvedValue({ png: fakePng, width: 100, height: 50 })
    const app = makeApp()

    const res = await app.request('/api/canvas/s1/canvas-a/export', { method: 'POST' })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { filePath: string }
    expect(body.filePath).toMatch(/canvas-a-.*\.excalidraw\.png$/)
    expect(mockExportCanvasHeadless).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 's1', slug: 'canvas-a' }),
    )
    expect(mockSendExportRequest).not.toHaveBeenCalled()

    const written = await readFile(body.filePath)
    expect(written.equals(fakePng)).toBe(true)
  })

  it('generates distinct default filePaths for two headless exports in the same millisecond', async () => {
    // The default path used to be slug + millisecond timestamp only, so two
    // exports issued fast enough to land in the same millisecond would
    // collide and the second write would silently clobber the first.
    mockGetClientCount.mockReturnValue(0)
    mockExportCanvasHeadless.mockResolvedValue({
      png: Buffer.from('fake-png-bytes'),
      width: 100,
      height: 50,
    })
    const app = makeApp()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    try {
      const [resA, resB] = await Promise.all([
        app.request('/api/canvas/s1/canvas-a/export', { method: 'POST' }),
        app.request('/api/canvas/s1/canvas-a/export', { method: 'POST' }),
      ])
      const bodyA = (await resA.json()) as { filePath: string }
      const bodyB = (await resB.json()) as { filePath: string }
      expect(bodyA.filePath).not.toBe(bodyB.filePath)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns 404 with canvas_not_found when no browser is connected and the canvas does not exist', async () => {
    // Headless fallback used to silently succeed for unknown canvasIds:
    // getDoc + loadCanvas hand back an empty LoroDoc on cache miss, so a
    // typo would happily produce a blank PNG. Surface it as a 404 instead.
    mockGetClientCount.mockReturnValue(0)
    mockCanvasExists.mockResolvedValueOnce(false)
    const app = makeApp()

    const res = await app.request('/api/canvas/s1/missing-canvas/export', { method: 'POST' })

    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string; message?: string }
    expect(body.error).toBe('canvas_not_found')
    // Refuse before paying the resvg startup cost.
    expect(mockExportCanvasHeadless).not.toHaveBeenCalled()
  })

  it('returns 500 with headless_export_failed when headless rendering throws', async () => {
    mockGetClientCount.mockReturnValue(0)
    mockExportCanvasHeadless.mockRejectedValue(new Error('boom'))
    const app = makeApp()
    const res = await app.request('/api/canvas/s1/canvas-a/export', { method: 'POST' })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('headless_export_failed')
    expect(body.message).toBe('boom')
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

  it('clears the timeout timer once the WS client resolves early', async () => {
    mockGetClientCount.mockReturnValue(1)
    mockSendExportRequest.mockImplementation((_sid, _slug, requestId) => {
      queueMicrotask(() => {
        resolveExportRequest(
          requestId,
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        )
      })
    })
    const app = makeApp({ timeoutMs: 5_000 })

    vi.useFakeTimers()
    try {
      const res = await app.request('/api/canvas/s1/canvas-a/export', { method: 'POST' })
      expect(res.status).toBe(200)
      // A leaked timer would still be pending here, ticking until timeoutMs.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
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
    expect(mockSendExportRequest).toHaveBeenCalledWith('s1', 'canvas-a', expect.any(String), {
      padding: 48,
    })
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

  it('forwards theme to sendExportRequest options when a WS client is connected', async () => {
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
      body: JSON.stringify({ theme: 'dark' }),
    })
    expect(res.status).toBe(200)
    const call = mockSendExportRequest.mock.calls[0]
    expect(call[3]).toEqual({ theme: 'dark' })
  })

  it('forwards theme to the headless export when no WS client is connected', async () => {
    mockGetClientCount.mockReturnValue(0)
    const fakePng = Buffer.from('fake-dark-png')
    mockExportCanvasHeadless.mockResolvedValue({ png: fakePng, width: 100, height: 50 })
    const app = makeApp()

    const res = await app.request('/api/canvas/s1/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'dark', padding: 16 }),
    })
    expect(res.status).toBe(200)
    expect(mockExportCanvasHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 's1',
        slug: 'canvas-a',
        options: expect.objectContaining({ theme: 'dark', padding: 16 }),
      }),
    )
  })

  it('rejects invalid theme values with 400 invalid_request', async () => {
    mockGetClientCount.mockReturnValue(1)
    const app = makeApp()
    const res = await app.request('/api/canvas/s1/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'sepia' }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_request' })
    expect(mockSendExportRequest).not.toHaveBeenCalled()
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
    const res = await app.request('/api/canvas/s1/architecture%2Foverview/export', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { filePath: string }
    expect(body.filePath).toMatch(/exports\/architecture\/overview-.*\.png$/)
  })

  it('returns 400 for invalid workspaceId or slug without reaching WS', async () => {
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
    const outputPath = join(tempDir, 's1', 'exports', 'subdir', 'custom.excalidraw.png')

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

  it('rejects outputPath outside the workspace exports dir even if inside DATA_DIR', async () => {
    mockGetClientCount.mockReturnValue(1)
    const app = makeApp()
    // ${DATA_DIR}/daemon.json is inside DATA_DIR but not inside ${DATA_DIR}/s1/exports
    const daemonFile = join(tempDir, 'daemon.json')
    const res = await app.request('/api/canvas/s1/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath: daemonFile }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_output_path' })
    expect(mockSendExportRequest).not.toHaveBeenCalled()
  })

  it('rejects outputPath outside workspace exports dir (different workspace checkpoints)', async () => {
    mockGetClientCount.mockReturnValue(1)
    const app = makeApp()
    // ${DATA_DIR}/s1/.checkpoints is inside DATA_DIR/s1 but not in ${DATA_DIR}/s1/exports
    const checkpointFile = join(tempDir, 's1', '.checkpoints', 'v1.json')
    const res = await app.request('/api/canvas/s1/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath: checkpointFile }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_output_path' })
    expect(mockSendExportRequest).not.toHaveBeenCalled()
  })

  it('rejects outputPath fully outside DATA_DIR', async () => {
    mockGetClientCount.mockReturnValue(1)
    const app = makeApp()
    const res = await app.request('/api/canvas/s1/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath: '/tmp/attack.png' }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_output_path' })
    expect(mockSendExportRequest).not.toHaveBeenCalled()
  })

  it('does not leak internal paths in invalid_output_path error response', async () => {
    mockGetClientCount.mockReturnValue(1)
    const app = makeApp()
    const res = await app.request('/api/canvas/s1/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath: join(tempDir, 'daemon.json') }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('invalid_output_path')
    expect(body.message).not.toContain(tempDir)
    expect(body.message).not.toContain('daemon.json')
  })

  it('does not leak internal paths in output_exists error response', async () => {
    mockGetClientCount.mockReturnValue(1)
    const app = makeApp()
    const outputPath = join(tempDir, 's1', 'exports', 'exists.png')
    await mkdir(join(tempDir, 's1', 'exports'), { recursive: true })
    await writeFile(outputPath, 'OLD')
    const res = await app.request('/api/canvas/s1/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('output_exists')
    expect(body.message).not.toContain(tempDir)
    expect(body.message).not.toContain('exists.png')
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
    const outputPath = join(tempDir, 's1', 'exports', 'pre-existing.png')
    await mkdir(join(tempDir, 's1', 'exports'), { recursive: true })
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
    const outputPath = join(tempDir, 's1', 'exports', 'replace.png')
    await mkdir(join(tempDir, 's1', 'exports'), { recursive: true })
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
