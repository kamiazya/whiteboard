import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const client = {
  port: 3099,
  baseUrl: 'http://localhost:3099',
  request: (path: string, init?: RequestInit) =>
    globalThis.fetch(new URL(path, 'http://localhost:3099'), init),
  touch: async () => undefined,
}

describe('viewportSetTool execute', () => {
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

  it('case 266', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { viewportSetTool } = await import('./viewport.js')
    const tool = viewportSetTool()
    const res = await tool.execute(
      {
        canvasId: 'sid/slug',
        mode: 'fit',
        elementIds: ['a', 'b'],
        padding: 40,
        animate: true,
      },
      client,
    )

    expect(res).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url.toString()).toBe('http://localhost:3099/api/canvas/sid/slug/viewport')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      mode: 'fit',
      elementIds: ['a', 'b'],
      padding: 40,
      animate: true,
    })
  })

  it('case 267', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { viewportSetTool } = await import('./viewport.js')
    const tool = viewportSetTool()
    await tool.execute({ canvasId: 'sid/slug', mode: 'fit' }, client)

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init?.body as string) as Record<string, unknown>
    expect(body).toEqual({ mode: 'fit' })
    expect('elementIds' in body).toBe(false)
    expect('padding' in body).toBe(false)
    expect('animate' in body).toBe(false)
  })

  it('case 268', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { viewportSetTool } = await import('./viewport.js')
    const tool = viewportSetTool()
    await tool.execute(
      { canvasId: 'sid/slug', mode: 'move', scrollX: 100, scrollY: 200, zoom: 1.5 },
      client,
    )

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init?.body as string)).toEqual({
      mode: 'move',
      scrollX: 100,
      scrollY: 200,
      zoom: 1.5,
    })
  })

  it('case 269', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { viewportSetTool } = await import('./viewport.js')
    const tool = viewportSetTool()
    await tool.execute({ canvasId: 'sid/slug' }, client)

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init?.body as string)).toEqual({ mode: 'fit' })
  })

  it('case 270', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'no_client',
          message: 'No browser client connected.',
          hint: 'Open the canvas first.',
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const { viewportSetTool } = await import('./viewport.js')
    const tool = viewportSetTool()
    await expect(tool.execute({ canvasId: 'sid/slug' }, client)).rejects.toThrow(
      /No browser client connected\..*Hint: Open the canvas first\./,
    )
  })

  it('case 271', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'timeout', message: 'Viewport update timed out.' }),
        { status: 504, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const { viewportSetTool } = await import('./viewport.js')
    const tool = viewportSetTool()
    await expect(tool.execute({ canvasId: 'sid/slug' }, client)).rejects.toThrow(
      'Viewport update timed out.',
    )
  })

  it('case 272', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { viewportSetTool } = await import('./viewport.js')
    const tool = viewportSetTool()
    await expect(tool.execute({ canvasId: 'sid/slug' }, client)).rejects.toThrow(
      /Viewport update failed: 500 boom/,
    )
  })

  it('case 273', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { viewportSetTool } = await import('./viewport.js')
    const tool = viewportSetTool()
    await tool.execute({ canvasId: 'sid/621/header' }, client)

    const [url] = fetchMock.mock.calls[0]
    expect(url.toString()).toBe('http://localhost:3099/api/canvas/sid/621%2Fheader/viewport')
  })

  it('case 274', async () => {
    const { viewportSetTool } = await import('./viewport.js')
    const tool = viewportSetTool()

    await expect(tool.execute({ canvasId: 'bad.sid/slug' }, client)).rejects.toThrow(
      /Invalid sessionId "bad\.sid"/,
    )
    await expect(tool.execute({ canvasId: 'sid/bad.slug' }, client)).rejects.toThrow(
      /Invalid slug "bad\.slug"/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
