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

describe('exportPngTool execute', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  it('case 366', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ filePath: '/tmp/out.png' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { exportPngTool } = await import('./export.js')
    const tool = exportPngTool()
    const res = await tool.execute({ canvasId: 'sid/slug', padding: 32 }, client)

    expect(res).toEqual({ filePath: '/tmp/out.png' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url.toString()).toBe('http://localhost:3099/api/canvas/sid/slug/export')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ padding: 32 })
  })

  it('case 367', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ filePath: '/tmp/out.png' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { exportPngTool } = await import('./export.js')
    const tool = exportPngTool()
    await tool.execute({ canvasId: 'sid/slug' }, client)

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init?.body as string)).toEqual({})
  })

  it('case 368', async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = input.toString()
      if (url === 'http://localhost:3099/api/canvas/sid/slug/export' && fetchMock.mock.calls.length === 1) {
        return new Response(
          JSON.stringify({
            error: 'no_client',
            message: 'No browser client connected.',
            hint: 'Open the canvas first.',
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url === 'http://localhost:3099/api/canvas/sid/slug/client-count') {
        return new Response(JSON.stringify({ count: 1, readyCount: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url === 'http://localhost:3099/api/canvas/sid/slug/export') {
        return new Response(JSON.stringify({ filePath: '/tmp/out.png' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    const { exportPngTool } = await import('./export.js')
    const tool = exportPngTool()
    await expect(tool.execute({ canvasId: 'sid/slug' }, client)).resolves.toEqual({
      filePath: '/tmp/out.png',
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('case 369', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = input.toString()
      if (url === 'http://localhost:3099/api/canvas/sid/slug/export') {
        return new Response(
          JSON.stringify({
            error: 'no_client',
            message: 'No browser client connected.',
            hint: 'Open the canvas first.',
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url === 'http://localhost:3099/api/canvas/sid/slug/client-count') {
        return new Response(JSON.stringify({ count: 0, readyCount: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const { exportPngTool } = await import('./export.js')
    const tool = exportPngTool()
    const pending = tool.execute({ canvasId: 'sid/slug' }, client)
    const assertion = expect(pending).rejects.toThrow(
      /No browser client connected\..*Hint: Open the canvas first\./,
    )
    await vi.advanceTimersByTimeAsync(5100)
    await assertion
  })

  it('case 370', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'timeout', message: 'Export timed out after 10s.' }),
        { status: 504, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const { exportPngTool } = await import('./export.js')
    const tool = exportPngTool()
    await expect(tool.execute({ canvasId: 'sid/slug' }, client)).rejects.toThrow(
      'Export timed out after 10s.',
    )
  })

  it('case 371', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'disk full' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { exportPngTool } = await import('./export.js')
    const tool = exportPngTool()
    await expect(tool.execute({ canvasId: 'sid/slug' }, client)).rejects.toThrow(
      /Export failed: 500 disk full/,
    )
  })

  it('case 372', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('not json', { status: 500 }),
    )

    const { exportPngTool } = await import('./export.js')
    const tool = exportPngTool()
    await expect(tool.execute({ canvasId: 'sid/slug' }, client)).rejects.toThrow(
      /Export failed: 500/,
    )
  })
  it('case 373', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ filePath: '/tmp/out.png' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { exportPngTool } = await import('./export.js')
    const tool = exportPngTool()
    await tool.execute({ canvasId: 'sid/slug', scale: 2 }, client)

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init?.body as string)).toEqual({ scale: 2 })
  })

  it('case 374', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ filePath: '/tmp/out.png' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { exportPngTool } = await import('./export.js')
    const tool = exportPngTool()
    await tool.execute({ canvasId: 'sid/slug', minFontPx: 14 }, client)

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init?.body as string)).toEqual({ minFontPx: 14 })
  })

  it('case 375', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ filePath: '/tmp/out.png' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { exportPngTool } = await import('./export.js')
    const tool = exportPngTool()
    await tool.execute(
      { canvasId: 'sid/slug', padding: 32, scale: 2, minFontPx: 14 },
      client,
    )

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init?.body as string)).toEqual({
      padding: 32,
      scale: 2,
      minFontPx: 14,
    })
  })

  it('case 376', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ filePath: '/tmp/out.png' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { exportPngTool } = await import('./export.js')
    const tool = exportPngTool()
    await tool.execute({ canvasId: 'sid/slug', padding: 16 }, client)

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init?.body as string) as Record<string, unknown>
    expect(body).toEqual({ padding: 16 })
    expect('scale' in body).toBe(false)
    expect('minFontPx' in body).toBe(false)
  })

  it('case 377', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'export-png-test-'))
    const filePath = join(dir, 'out.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03])
    await writeFile(filePath, bytes)
    try {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ filePath }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      const { exportPngTool } = await import('./export.js')
      const tool = exportPngTool()
      const res = await tool.execute({ canvasId: 'sid/slug' }, client)
      expect(res.filePath).toBe(filePath)
      expect(res.imageBase64).toBe(bytes.toString('base64'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('case 378', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ filePath: '/does-not-exist/whiteboard-xyz/out.png' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const { exportPngTool } = await import('./export.js')
    const tool = exportPngTool()
    const res = await tool.execute({ canvasId: 'sid/slug' }, client)
    expect(res.filePath).toBe('/does-not-exist/whiteboard-xyz/out.png')
    expect(res.imageBase64).toBeUndefined()
  })

  it('case 379', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ filePath: '/tmp/out.png' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { exportPngTool } = await import('./export.js')
    const tool = exportPngTool()
    await tool.execute({ canvasId: 'sid/621/header' }, client)

    const [url] = fetchMock.mock.calls[0]
    expect(url.toString()).toBe('http://localhost:3099/api/canvas/sid/621%2Fheader/export')
  })

  it('forwards outputPath and overwrite to the daemon export route', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ filePath: '/abs/canvas.excalidraw.png' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { exportPngTool } = await import('./export.js')
    const tool = exportPngTool()
    await tool.execute(
      {
        canvasId: 'sid/slug',
        outputPath: '/abs/canvas.excalidraw.png',
        overwrite: true,
      },
      client,
    )

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init?.body as string)).toEqual({
      outputPath: '/abs/canvas.excalidraw.png',
      overwrite: true,
    })
  })

  it('surfaces invalid_output_path errors from the export route', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'invalid_output_path',
          message: 'outputPath must be an absolute path (received: relative.png)',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const { exportPngTool } = await import('./export.js')
    const tool = exportPngTool()
    await expect(
      tool.execute(
        { canvasId: 'sid/slug', outputPath: 'relative.png' },
        client,
      ),
    ).rejects.toThrow(/absolute path/)
  })

  it('surfaces output_exists when the target file already exists', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'output_exists',
          message:
            'outputPath already exists. Pass overwrite=true to replace it: /abs/canvas.png',
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const { exportPngTool } = await import('./export.js')
    const tool = exportPngTool()
    await expect(
      tool.execute(
        { canvasId: 'sid/slug', outputPath: '/abs/canvas.png' },
        client,
      ),
    ).rejects.toThrow(/already exists/)
  })
})
