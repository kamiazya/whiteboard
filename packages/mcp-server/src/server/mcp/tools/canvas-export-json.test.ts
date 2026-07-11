import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { canvasExportJsonTool } = await import('./canvas-export-json.js')
const client = {
  port: 3099,
  baseUrl: 'http://localhost:3099',
  request: (path: string, init?: RequestInit) =>
    globalThis.fetch(new URL(path, 'http://localhost:3099'), init),
  touch: async () => undefined,
}

describe('canvas_export_json', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('delegates export to the daemon route', async () => {
    const tool = canvasExportJsonTool()
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(input.toString()).toBe('http://localhost:3099/api/canvas/sid/canvas-a/export-json')
      expect(init?.method).toBe('POST')
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
      expect(init?.body).toBe(JSON.stringify({ includeCustomFields: false }))
      return new Response(
        JSON.stringify({
          filePath: '/tmp/export.excalidraw',
          elementCount: 1,
        }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch

    await expect(tool.execute({ canvasId: 'sid/canvas-a' }, client)).resolves.toEqual({
      filePath: '/tmp/export.excalidraw',
      elementCount: 1,
    })
  })

  it('passes includeCustomFields through to the daemon route', async () => {
    const tool = canvasExportJsonTool()
    globalThis.fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.body).toBe(JSON.stringify({ includeCustomFields: true }))
      return new Response(
        JSON.stringify({
          filePath: '/tmp/export.excalidraw',
          elementCount: 1,
        }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch

    await expect(
      tool.execute({ canvasId: 'sid/canvas-a', includeCustomFields: true }, client),
    ).resolves.toEqual({
      filePath: '/tmp/export.excalidraw',
      elementCount: 1,
    })
  })

  it('forwards outputPath and overwrite to the daemon route', async () => {
    const tool = canvasExportJsonTool()
    let captured: unknown
    globalThis.fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      captured = init?.body !== undefined ? JSON.parse(init.body as string) : undefined
      return new Response(JSON.stringify({ filePath: '/abs/out.excalidraw', elementCount: 0 }), {
        status: 200,
      })
    }) as typeof globalThis.fetch

    await tool.execute(
      { canvasId: 'sid/canvas-a', outputPath: '/abs/out.excalidraw', overwrite: true },
      client,
    )
    expect(captured).toEqual({
      includeCustomFields: false,
      outputPath: '/abs/out.excalidraw',
      overwrite: true,
    })
  })

  it('surfaces invalid_output_path errors from the daemon route as a clear message', async () => {
    const tool = canvasExportJsonTool()
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: 'invalid_output_path',
          message: 'outputPath must be an absolute path (received: relative.json)',
        }),
        { status: 400 },
      )
    }) as typeof globalThis.fetch

    await expect(
      tool.execute({ canvasId: 'sid/canvas-a', outputPath: 'relative.json' }, client),
    ).rejects.toThrow(/absolute path/)
  })

  it("documents the outputPath sandbox constraint in the tool's inputSchema description", () => {
    const tool = canvasExportJsonTool()
    const description = tool.inputSchema.properties.outputPath.description
    expect(description).toMatch(/exports directory/)
    expect(description).toMatch(/WHITEBOARD_DATA_DIR/)
  })

  it('surfaces output_exists errors when overwrite is omitted', async () => {
    const tool = canvasExportJsonTool()
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: 'output_exists',
          message: 'outputPath already exists. Pass overwrite=true to replace it: /abs/out.json',
        }),
        { status: 409 },
      )
    }) as typeof globalThis.fetch

    await expect(
      tool.execute({ canvasId: 'sid/canvas-a', outputPath: '/abs/out.json' }, client),
    ).rejects.toThrow(/already exists/)
  })

  it('rejects when daemon response is missing required fields (schema mismatch)', async () => {
    const tool = canvasExportJsonTool()
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ filePath: '/tmp/export.excalidraw' }), // elementCount missing
        { status: 200 },
      )
    }) as typeof globalThis.fetch

    await expect(tool.execute({ canvasId: 'sid/canvas-a' }, client)).rejects.toThrow()
  })
})
