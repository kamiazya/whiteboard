import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const mockExportCanvasHeadlessSvg =
  vi.fn<
    (args: {
      workspaceId: string
      path: string
      options?: { padding?: number; frameId?: string; theme?: 'light' | 'dark' }
    }) => Promise<{ svg: string }>
  >()
vi.mock('../../export/headless-export.js', () => ({
  exportCanvasHeadlessSvg: (args: {
    workspaceId: string
    path: string
    options?: { padding?: number; frameId?: string; theme?: 'light' | 'dark' }
  }) => mockExportCanvasHeadlessSvg(args),
}))

const { createDocumentSvgExportRouter } = await import('./export-svg.js')

function makeApp() {
  const app = new Hono()
  app.route('/', createDocumentSvgExportRouter())
  return app
}

describe('POST /api/w/:workspaceId/document/:path/export-svg', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-export-svg-test-'))
    mockExportCanvasHeadlessSvg.mockReset()
    mockExportCanvasHeadlessSvg.mockResolvedValue({ svg: '<svg><rect/></svg>' })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('renders headlessly and writes a real .svg file to the default exports dir', async () => {
    const app = makeApp()

    const res = await app.request('/api/w/s1/document/canvas-a/export-svg', { method: 'POST' })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { filePath: string }
    expect(body.filePath).toMatch(/canvas-a-.*\.svg$/)
    expect(mockExportCanvasHeadlessSvg).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 's1', path: 'canvas-a' }),
    )
    const written = await readFile(body.filePath, 'utf-8')
    expect(written.trim().startsWith('<svg')).toBe(true)
  })

  it('generates distinct default filePaths for two exports in the same millisecond', async () => {
    // The default path used to be path + millisecond timestamp only, so two
    // exports issued fast enough to land in the same millisecond would
    // collide and the second write would silently clobber the first.
    const app = makeApp()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    try {
      const [resA, resB] = await Promise.all([
        app.request('/api/w/s1/document/canvas-a/export-svg', { method: 'POST' }),
        app.request('/api/w/s1/document/canvas-a/export-svg', { method: 'POST' }),
      ])
      const bodyA = (await resA.json()) as { filePath: string }
      const bodyB = (await resB.json()) as { filePath: string }
      expect(bodyA.filePath).not.toBe(bodyB.filePath)
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards padding, frameId, and theme to exportCanvasHeadlessSvg', async () => {
    const app = makeApp()

    const res = await app.request('/api/w/s1/document/canvas-a/export-svg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 24, frameId: 'frame-1', theme: 'dark' }),
    })

    expect(res.status).toBe(200)
    expect(mockExportCanvasHeadlessSvg).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 's1',
        path: 'canvas-a',
        options: expect.objectContaining({ padding: 24, frameId: 'frame-1', theme: 'dark' }),
      }),
    )
  })

  it('rejects invalid workspaceId or path with 400', async () => {
    const app = makeApp()
    const res = await app.request('/api/w/bad.sid/document/canvas-a/export-svg', { method: 'POST' })
    expect(res.status).toBe(400)
    expect(mockExportCanvasHeadlessSvg).not.toHaveBeenCalled()
  })

  it('rejects a whitespace-only body with 400 invalid_request instead of throwing', async () => {
    const app = makeApp()
    const res = await app.request('/api/w/s1/document/canvas-a/export-svg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '   ',
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_request' })
    expect(mockExportCanvasHeadlessSvg).not.toHaveBeenCalled()
  })

  it('rejects an invalid theme with 400 invalid_request', async () => {
    const app = makeApp()
    const res = await app.request('/api/w/s1/document/canvas-a/export-svg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'sepia' }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_request' })
    expect(mockExportCanvasHeadlessSvg).not.toHaveBeenCalled()
  })

  it('writes to an explicit outputPath inside the workspace exports dir', async () => {
    const app = makeApp()
    const outputPath = join(tempDir, 's1', 'exports', 'custom.svg')

    const res = await app.request('/api/w/s1/document/canvas-a/export-svg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { filePath: string }
    expect(body.filePath).toBe(outputPath)
  })

  it('rejects an outputPath outside the workspace exports dir with 400 invalid_output_path', async () => {
    const app = makeApp()
    const res = await app.request('/api/w/s1/document/canvas-a/export-svg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath: join(tempDir, 'daemon.json') }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_output_path' })
    expect(mockExportCanvasHeadlessSvg).not.toHaveBeenCalled()
  })

  it('refuses to overwrite an existing file by default and returns 409', async () => {
    const app = makeApp()
    const outputPath = join(tempDir, 's1', 'exports', 'pre-existing.svg')
    await mkdir(join(tempDir, 's1', 'exports'), { recursive: true })
    await writeFile(outputPath, '<svg>OLD</svg>')

    const res = await app.request('/api/w/s1/document/canvas-a/export-svg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath }),
    })
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({ error: 'output_exists' })
    await expect(readFile(outputPath, 'utf-8')).resolves.toBe('<svg>OLD</svg>')
  })

  it('overwrites an existing file when overwrite=true', async () => {
    const app = makeApp()
    const outputPath = join(tempDir, 's1', 'exports', 'replace.svg')
    await mkdir(join(tempDir, 's1', 'exports'), { recursive: true })
    await writeFile(outputPath, '<svg>OLD</svg>')

    const res = await app.request('/api/w/s1/document/canvas-a/export-svg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath, overwrite: true }),
    })
    expect(res.status).toBe(200)
    await expect(readFile(outputPath, 'utf-8')).resolves.toBe('<svg><rect/></svg>')
  })

  it('rejects an oversized request body with 413 payload_too_large', async () => {
    const app = makeApp()
    const oversized = 'x'.repeat(1024 * 1024 + 1)
    const res = await app.request('/api/w/s1/document/canvas-a/export-svg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversized,
    })
    expect(res.status).toBe(413)
    const body: unknown = await res.json()
    expect(body).toMatchObject({ error: 'payload_too_large' })
  })

  it('returns 500 headless_export_failed when rendering throws', async () => {
    mockExportCanvasHeadlessSvg.mockRejectedValue(new Error('boom'))
    const app = makeApp()
    const res = await app.request('/api/w/s1/document/canvas-a/export-svg', { method: 'POST' })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('headless_export_failed')
    expect(body.message).toBe('boom')
  })
})
