import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportResponseSchema } from '../../shared/api-contracts/export.js'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

// Mock ws.ts purely to observe that export never talks to it. getClientCount
// is kept as a spy so the metamorphic test can vary it; it must have no
// effect on export behavior post-headless-only.
const mockGetClientCount = vi.fn<(workspaceId: string, path: string) => number>()
const mockSendExportRequest = vi.fn<(...args: unknown[]) => void>()

vi.mock('./ws.js', () => ({
  getClientCount: (workspaceId: string, path: string) => mockGetClientCount(workspaceId, path),
  sendExportRequest: (...args: unknown[]) => mockSendExportRequest(...args),
}))

// Stub the headless renderer so route tests do not pull jsdom/document/resvg in
// every run.
type MockHeadlessArgs = {
  workspaceId: string
  path: string
  options?: {
    padding?: number
    scale?: number
    frameId?: string
    minFontPx?: number
    theme?: 'light' | 'dark'
  }
}
const mockExportCanvasHeadless =
  vi.fn<
    (args: MockHeadlessArgs) => Promise<{
      png: Buffer
      width: number
      height: number
      undrawable: readonly string[]
    }>
  >()

vi.mock('../export/headless-export.js', () => ({
  exportCanvasHeadless: (args: MockHeadlessArgs) => mockExportCanvasHeadless(args),
}))

// Default documentExists to true so existing tests that already construct a
// route + mock the headless renderer keep passing without each having to
// stub the metadata-DB lookup. Missing-canvas tests opt out by overriding
// the mock per-case.
const mockDocumentExists = vi.fn<(workspaceId: string, path: string) => Promise<boolean>>(
  async () => true,
)
vi.mock('../store/document-store.js', () => ({
  documentExists: (workspaceId: string, path: string) => mockDocumentExists(workspaceId, path),
}))

// Spies on the real implementation so most tests exercise genuine random
// suffixes, while the collision test below overrides specific calls.
vi.mock('nanoid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nanoid')>()
  return { ...actual, nanoid: vi.fn(actual.nanoid) }
})

const { createExportRouter } = await import('./export.js')

function makeApp() {
  const app = new Hono()
  app.route('/', createExportRouter())
  return app
}

const SAMPLE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

describe('POST /api/w/:workspaceId/document/:path/export - error handling', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-export-test-'))
    mockGetClientCount.mockReset()
    mockSendExportRequest.mockReset()
    mockExportCanvasHeadless.mockReset()
    mockDocumentExists.mockReset()
    mockDocumentExists.mockResolvedValue(true)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  // Load-bearing regression test: with a WS client connected, export must
  // still be served by the headless renderer, and nothing may be pushed to
  // the socket. Against the pre-change dual-path code this would take the
  // browser path (sendExportRequest called, no headless call) and fail.
  it('is served by the headless renderer even when a WS client is connected', async () => {
    mockGetClientCount.mockReturnValue(2)
    const fakePng = Buffer.from('fake-png-bytes')
    mockExportCanvasHeadless.mockResolvedValue({
      png: fakePng,
      width: 100,
      height: 50,
      undrawable: [],
    })
    const app = makeApp()

    const res = await app.request('/api/w/s1/document/canvas-a/export', { method: 'POST' })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { filePath: string }
    expect(mockExportCanvasHeadless).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 's1', path: 'canvas-a' }),
    )
    expect(mockSendExportRequest).not.toHaveBeenCalled()

    const written = await readFile(body.filePath)
    expect(written.equals(fakePng)).toBe(true)
  })

  // Metamorphic: client count must not be an input to export behavior at all.
  it('produces identical status/body/headless-args regardless of WS client count', async () => {
    const fakePng = Buffer.from('fake-png-bytes')
    mockExportCanvasHeadless.mockResolvedValue({
      png: fakePng,
      width: 100,
      height: 50,
      undrawable: [],
    })

    mockGetClientCount.mockReturnValue(0)
    const resNoClient = await makeApp().request('/api/w/s1/document/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 20 }),
    })
    const argsNoClient = mockExportCanvasHeadless.mock.calls[0][0]

    mockExportCanvasHeadless.mockClear()
    mockGetClientCount.mockReturnValue(3)
    const resWithClients = await makeApp().request('/api/w/s1/document/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 20 }),
    })
    const argsWithClients = mockExportCanvasHeadless.mock.calls[0][0]

    expect(resWithClients.status).toBe(resNoClient.status)
    expect(argsWithClients).toEqual(argsNoClient)
    expect(mockSendExportRequest).not.toHaveBeenCalled()
  })

  it('generates distinct default filePaths for two headless exports in the same millisecond', async () => {
    mockExportCanvasHeadless.mockResolvedValue({
      png: Buffer.from('fake-png-bytes'),
      width: 100,
      height: 50,
      undrawable: [],
    })
    const app = makeApp()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    try {
      const [resA, resB] = await Promise.all([
        app.request('/api/w/s1/document/canvas-a/export', { method: 'POST' }),
        app.request('/api/w/s1/document/canvas-a/export', { method: 'POST' }),
      ])
      const bodyA = (await resA.json()) as { filePath: string }
      const bodyB = (await resB.json()) as { filePath: string }
      expect(bodyA.filePath).not.toBe(bodyB.filePath)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns 404 with canvas_not_found when the canvas does not exist', async () => {
    // Headless rendering does NOT verify the canvas exists: getDoc / loadDocument
    // return an empty LoroDoc on cache miss, so a typo would otherwise
    // silently produce a blank PNG. Surfaced as 404 unconditionally now that
    // there is only one rendering path.
    mockDocumentExists.mockResolvedValueOnce(false)
    const app = makeApp()

    const res = await app.request('/api/w/s1/document/missing-canvas/export', { method: 'POST' })

    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string; message?: string }
    expect(body.error).toBe('canvas_not_found')
    // Refuse before paying the resvg startup cost.
    expect(mockExportCanvasHeadless).not.toHaveBeenCalled()
  })

  it('returns 500 with headless_export_failed when headless rendering throws', async () => {
    mockExportCanvasHeadless.mockRejectedValue(new Error('boom'))
    const app = makeApp()
    const res = await app.request('/api/w/s1/document/canvas-a/export', { method: 'POST' })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('headless_export_failed')
    expect(body.message).toBe('boom')
  })

  // No timeout-driven failure mode exists any longer. The headless render
  // resolving slowly (well past the old 10s browser-round-trip default) must
  // still succeed, never 504.
  it('resolves 200 even when headless rendering is slow, with no 504 timeout path', async () => {
    mockExportCanvasHeadless.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve({ png: Buffer.from('slow-png'), width: 10, height: 10, undrawable: [] }),
            50,
          )
        }),
    )
    const app = makeApp()
    const res = await app.request('/api/w/s1/document/canvas-a/export', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  it('passes padding through to exportCanvasHeadless options', async () => {
    mockExportCanvasHeadless.mockResolvedValue({
      png: Buffer.from('fake-png-bytes'),
      width: 100,
      height: 50,
      undrawable: [],
    })
    const app = makeApp()

    const res = await app.request('/api/w/s1/document/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 48 }),
    })
    expect(res.status).toBe(200)
    expect(mockExportCanvasHeadless).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ padding: 48 }) }),
    )
  })

  it('passes scale and minFontPx through to exportCanvasHeadless options', async () => {
    mockExportCanvasHeadless.mockResolvedValue({
      png: Buffer.from('fake-png-bytes'),
      width: 100,
      height: 50,
      undrawable: [],
    })
    const app = makeApp()

    const res = await app.request('/api/w/s1/document/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 32, scale: 2, minFontPx: 14 }),
    })
    expect(res.status).toBe(200)
    expect(mockExportCanvasHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ padding: 32, scale: 2, minFontPx: 14 }),
      }),
    )
  })

  // Client-count independence is covered once by the metamorphic test above,
  // so this only needs to assert the forwarding itself.
  it('forwards theme to the headless export', async () => {
    const fakePng = Buffer.from('fake-dark-png')
    mockExportCanvasHeadless.mockResolvedValue({
      png: fakePng,
      width: 100,
      height: 50,
      undrawable: [],
    })
    const app = makeApp()

    const res = await app.request('/api/w/s1/document/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'dark', padding: 16 }),
    })
    expect(res.status).toBe(200)
    expect(mockExportCanvasHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 's1',
        path: 'canvas-a',
        options: expect.objectContaining({ theme: 'dark', padding: 16 }),
      }),
    )
  })

  it('rejects invalid theme values with 400 invalid_request', async () => {
    const app = makeApp()
    const res = await app.request('/api/w/s1/document/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'sepia' }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_request' })
    expect(mockExportCanvasHeadless).not.toHaveBeenCalled()
  })

  it('rejects an oversized request body with 413 payload_too_large', async () => {
    const app = makeApp()
    const oversized = 'x'.repeat(1024 * 1024 + 1)
    const res = await app.request('/api/w/s1/document/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversized,
    })
    expect(res.status).toBe(413)
    const body: unknown = await res.json()
    expect(body).toMatchObject({ error: 'payload_too_large' })
  })

  it('passes frameId through to exportCanvasHeadless options', async () => {
    mockExportCanvasHeadless.mockResolvedValue({
      png: Buffer.from('fake-png-bytes'),
      width: 100,
      height: 50,
      undrawable: [],
    })
    const app = makeApp()

    const res = await app.request('/api/w/s1/document/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frameId: 'frame-abc', padding: 24 }),
    })
    expect(res.status).toBe(200)
    expect(mockExportCanvasHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ frameId: 'frame-abc', padding: 24 }),
      }),
    )
  })

  it('returns 200 and filePath for a plain export request', async () => {
    mockExportCanvasHeadless.mockResolvedValue({
      png: Buffer.from(SAMPLE_PNG_BASE64, 'base64'),
      width: 1,
      height: 1,
      undrawable: [],
    })
    const app = makeApp()

    const res = await app.request('/api/w/s1/document/canvas-a/export', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { filePath: string }
    expect(body.filePath).toMatch(/canvas-a-.*\.png$/)
  })

  // The renderer has always known which characters it could not draw; the
  // route dropped the answer on the floor. This path's caller is an agent over
  // HTTP, and a PNG it exported has already lost them.
  it('reports the characters the export renderer had no glyph for', async () => {
    mockExportCanvasHeadless.mockResolvedValue({
      png: Buffer.from(SAMPLE_PNG_BASE64, 'base64'),
      width: 1,
      height: 1,
      undrawable: ['日', '本'],
    })

    const res = await makeApp().request('/api/w/s1/document/canvas-a/export', { method: 'POST' })

    expect(res.status).toBe(200)
    // Parsed, not cast: the point is that the field survives the contract.
    expect(exportResponseSchema.parse(await res.json()).undrawable).toEqual(['日', '本'])
  })

  it('reports an empty list when every character drew', async () => {
    mockExportCanvasHeadless.mockResolvedValue({
      png: Buffer.from(SAMPLE_PNG_BASE64, 'base64'),
      width: 1,
      height: 1,
      undrawable: [],
    })

    const res = await makeApp().request('/api/w/s1/document/canvas-a/export', { method: 'POST' })

    // Present and empty rather than absent: a caller must be able to tell
    // "nothing was lost" from "this daemon does not report".
    expect(exportResponseSchema.parse(await res.json()).undrawable).toEqual([])
  })

  // Nested canvas paths such as architecture/overview should create parent
  // directories recursively instead of failing with ENOENT.
  it('never clobbers an existing default-path file when nanoid produces a collision', async () => {
    // Force a nanoid collision on the first two calls to prove the write
    // path retries with a new random suffix instead of silently
    // overwriting an export that landed on the exact same generated name.
    const { nanoid } = await import('nanoid')
    vi.mocked(nanoid).mockReturnValueOnce('aaaaaa').mockReturnValueOnce('aaaaaa')

    mockExportCanvasHeadless
      .mockResolvedValueOnce({ png: Buffer.from('first-png'), width: 1, height: 1, undrawable: [] })
      .mockResolvedValueOnce({
        png: Buffer.from('second-png'),
        width: 1,
        height: 1,
        undrawable: [],
      })
    const app = makeApp()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    try {
      const resA = await app.request('/api/w/s1/document/canvas-a/export', { method: 'POST' })
      const bodyA = (await resA.json()) as { filePath: string }
      const resB = await app.request('/api/w/s1/document/canvas-a/export', { method: 'POST' })
      const bodyB = (await resB.json()) as { filePath: string }

      expect(resA.status).toBe(200)
      expect(resB.status).toBe(200)
      expect(bodyA.filePath).not.toBe(bodyB.filePath)
      await expect(readFile(bodyA.filePath, 'utf-8')).resolves.toBe('first-png')
      await expect(readFile(bodyB.filePath, 'utf-8')).resolves.toBe('second-png')
    } finally {
      vi.useRealTimers()
      vi.mocked(nanoid).mockReset()
    }
  })

  it('writes nested slash-containing paths without ENOENT', async () => {
    mockExportCanvasHeadless.mockResolvedValue({
      png: Buffer.from(SAMPLE_PNG_BASE64, 'base64'),
      width: 1,
      height: 1,
      undrawable: [],
    })
    const app = makeApp()

    // MCP sends the path through encodeURIComponent, so it arrives as one segment with `%2F`.
    const res = await app.request('/api/w/s1/document/architecture%2Foverview/export', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { filePath: string }
    expect(body.filePath).toMatch(/exports\/architecture\/overview-.*\.png$/)
  })

  it('returns 400 for invalid workspaceId or path without reaching the headless renderer', async () => {
    const app = makeApp()

    const badSession = await app.request('/api/w/bad.sid/document/canvas-a/export', {
      method: 'POST',
    })
    expect(badSession.status).toBe(400)

    const badPath = await app.request('/api/w/s1/document/bad.path/export', {
      method: 'POST',
    })
    expect(badPath.status).toBe(400)
    expect(mockExportCanvasHeadless).not.toHaveBeenCalled()
  })

  it('writes the PNG to an explicit absolute outputPath when provided', async () => {
    mockExportCanvasHeadless.mockResolvedValue({
      png: Buffer.from(SAMPLE_PNG_BASE64, 'base64'),
      width: 1,
      height: 1,
      undrawable: [],
    })
    const app = makeApp()
    const outputPath = join(tempDir, 's1', 'exports', 'subdir', 'custom.excalidraw.png')

    const res = await app.request('/api/w/s1/document/canvas-a/export', {
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
    const app = makeApp()
    // ${DATA_DIR}/daemon.json is inside DATA_DIR but not inside ${DATA_DIR}/s1/exports
    const daemonFile = join(tempDir, 'daemon.json')
    const res = await app.request('/api/w/s1/document/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath: daemonFile }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_output_path' })
    expect(mockExportCanvasHeadless).not.toHaveBeenCalled()
  })

  it('rejects outputPath outside workspace exports dir (different workspace checkpoints)', async () => {
    const app = makeApp()
    // ${DATA_DIR}/s1/.checkpoints is inside DATA_DIR/s1 but not in ${DATA_DIR}/s1/exports
    const checkpointFile = join(tempDir, 's1', '.checkpoints', 'v1.json')
    const res = await app.request('/api/w/s1/document/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath: checkpointFile }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_output_path' })
    expect(mockExportCanvasHeadless).not.toHaveBeenCalled()
  })

  it('rejects outputPath fully outside DATA_DIR', async () => {
    const app = makeApp()
    const res = await app.request('/api/w/s1/document/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath: '/tmp/attack.png' }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_output_path' })
    expect(mockExportCanvasHeadless).not.toHaveBeenCalled()
  })

  it('does not leak internal paths in invalid_output_path error response', async () => {
    const app = makeApp()
    const res = await app.request('/api/w/s1/document/canvas-a/export', {
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
    const app = makeApp()
    const outputPath = join(tempDir, 's1', 'exports', 'exists.png')
    await mkdir(join(tempDir, 's1', 'exports'), { recursive: true })
    await writeFile(outputPath, 'OLD')
    const res = await app.request('/api/w/s1/document/canvas-a/export', {
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
    const app = makeApp()
    const res = await app.request('/api/w/s1/document/canvas-a/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath: 'relative/out.png' }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_output_path' })
    expect(mockExportCanvasHeadless).not.toHaveBeenCalled()
  })

  it('refuses to overwrite an existing PNG by default and returns 409', async () => {
    mockExportCanvasHeadless.mockResolvedValue({
      png: Buffer.from(SAMPLE_PNG_BASE64, 'base64'),
      width: 1,
      height: 1,
      undrawable: [],
    })
    const app = makeApp()
    const outputPath = join(tempDir, 's1', 'exports', 'pre-existing.png')
    await mkdir(join(tempDir, 's1', 'exports'), { recursive: true })
    await writeFile(outputPath, 'OLD')

    const res = await app.request('/api/w/s1/document/canvas-a/export', {
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
    mockExportCanvasHeadless.mockResolvedValue({
      png: Buffer.from(SAMPLE_PNG_BASE64, 'base64'),
      width: 1,
      height: 1,
      undrawable: [],
    })
    const app = makeApp()
    const outputPath = join(tempDir, 's1', 'exports', 'replace.png')
    await mkdir(join(tempDir, 's1', 'exports'), { recursive: true })
    await writeFile(outputPath, 'OLD')

    const res = await app.request('/api/w/s1/document/canvas-a/export', {
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
