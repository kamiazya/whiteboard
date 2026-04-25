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
      expect(input.toString()).toBe(
        'http://localhost:3099/api/canvas/sid/canvas-a/export-json',
      )
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
})
