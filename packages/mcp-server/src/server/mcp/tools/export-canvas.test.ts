import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const client = {
  port: 3099,
  baseUrl: 'http://localhost:3099',
  request: (path: string, init?: RequestInit) =>
    globalThis.fetch(new URL(path, 'http://localhost:3099'), init),
  touch: async () => undefined,
}

describe('exportCanvasTool execute', () => {
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

  it('routes format:"png" to the PNG export route and tags the result', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ filePath: '/tmp/out.png' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { exportCanvasTool } = await import('./export-canvas.js')
    const tool = exportCanvasTool()
    const res = await tool.execute({ canvasId: 'sid/slug', format: 'png', scale: 2 }, client)

    expect(res).toEqual({ format: 'png', filePath: '/tmp/out.png' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url.toString()).toBe('http://localhost:3099/api/canvas/sid/slug/export')
    expect(JSON.parse(init?.body as string)).toEqual({ scale: 2 })
  })

  it('routes format:"svg" to the SVG export route and tags the result', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ filePath: '/tmp/out.svg' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { exportCanvasTool } = await import('./export-canvas.js')
    const tool = exportCanvasTool()
    const res = await tool.execute({ canvasId: 'sid/slug', format: 'svg', frameId: 'f1' }, client)

    expect(res).toEqual({ format: 'svg', filePath: '/tmp/out.svg' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url.toString()).toBe('http://localhost:3099/api/canvas/sid/slug/export-svg')
    expect(JSON.parse(init?.body as string)).toEqual({ frameId: 'f1' })
  })

  it('routes format:"json" to the JSON export route and tags the result', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ filePath: '/tmp/out.excalidraw', elementCount: 3 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { exportCanvasTool } = await import('./export-canvas.js')
    const tool = exportCanvasTool()
    const res = await tool.execute(
      { canvasId: 'sid/slug', format: 'json', includeCustomFields: true },
      client,
    )

    expect(res).toEqual({ format: 'json', filePath: '/tmp/out.excalidraw', elementCount: 3 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url.toString()).toBe('http://localhost:3099/api/canvas/sid/slug/export-json')
    expect(JSON.parse(init?.body as string)).toEqual({ includeCustomFields: true })
  })

  it('rejects an unsupported format instead of silently rendering PNG', async () => {
    // The registered MCP tool's inputSchema (a Zod enum) rejects an
    // out-of-enum format before this ever runs. This guards the function
    // itself: a caller that bypasses that boundary (direct unit-test call,
    // a future refactor of the format switch) must not have "unknown format"
    // silently resolve into the PNG branch — the whole point of `format` is
    // that it is the contract, not a suggestion.
    const { exportCanvasTool } = await import('./export-canvas.js')
    const tool = exportCanvasTool()

    await expect(
      tool.execute({ canvasId: 'sid/slug', format: 'pdf' as unknown as 'png' }, client),
    ).rejects.toThrow(/unsupported format/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
