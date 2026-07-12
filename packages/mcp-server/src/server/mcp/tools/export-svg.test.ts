import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const client = {
  port: 3099,
  baseUrl: 'http://localhost:3099',
  request: (path: string, init?: RequestInit) =>
    globalThis.fetch(new URL(path, 'http://localhost:3099'), init),
  touch: async () => undefined,
}

describe('exportSvgTool execute', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('delegates to the export-svg daemon route and forwards options', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ filePath: '/tmp/out.svg' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { exportSvgTool } = await import('./export-svg.js')
    const tool = exportSvgTool()
    const res = await tool.execute(
      { canvasId: 'sid/slug', padding: 24, frameId: 'frame-1', theme: 'dark' },
      client,
    )

    expect(res).toEqual({ filePath: '/tmp/out.svg' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url.toString()).toBe('http://localhost:3099/api/canvas/sid/slug/export-svg')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      padding: 24,
      frameId: 'frame-1',
      theme: 'dark',
    })
  })

  it('sends an empty body when no options are provided', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ filePath: '/tmp/out.svg' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { exportSvgTool } = await import('./export-svg.js')
    const tool = exportSvgTool()
    await tool.execute({ canvasId: 'sid/slug' }, client)

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init?.body as string)).toEqual({})
  })

  it('inlines svgMarkup when the written file is small enough to read back', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-export-svg-tool-'))
    const filePath = join(tempDir, 'out.svg')
    await writeFile(filePath, '<svg><rect/></svg>')

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ filePath }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    try {
      const { exportSvgTool } = await import('./export-svg.js')
      const tool = exportSvgTool()
      const res = await tool.execute({ canvasId: 'sid/slug' }, client)
      expect(res).toEqual({ filePath, svgMarkup: '<svg><rect/></svg>' })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('omits svgMarkup when the file cannot be read back (e.g. already removed)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ filePath: '/tmp/does-not-exist-whiteboard.svg' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { exportSvgTool } = await import('./export-svg.js')
    const tool = exportSvgTool()
    const res = await tool.execute({ canvasId: 'sid/slug' }, client)
    expect(res).toEqual({ filePath: '/tmp/does-not-exist-whiteboard.svg' })
  })

  it('surfaces a daemon error as a clear message', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'invalid_request', message: 'invalid export options' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )

    const { exportSvgTool } = await import('./export-svg.js')
    const tool = exportSvgTool()
    await expect(tool.execute({ canvasId: 'sid/slug' }, client)).rejects.toThrow(
      'invalid export options',
    )
  })
})
