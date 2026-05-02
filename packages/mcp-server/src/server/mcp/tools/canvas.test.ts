import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tempDir: string

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_APP_DIR: '/tmp/whiteboard/dist/app',
}))
vi.mock('nanoid', () => ({
  nanoid: () => 'test-session-id',
}))

const { createCanvasTool, listCanvasTool, openCanvasTool, optimizeCanvasesTool } = await import(
  './canvas.js'
)
const client = {
  port: 3099,
  baseUrl: 'http://localhost:3099',
  request: (path: string, init?: RequestInit) =>
    globalThis.fetch(new URL(path, 'http://localhost:3099'), init),
  touch: async () => undefined,
}

describe('canvas_create', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-mcp-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('case 97', async () => {
    const tool = createCanvasTool()
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(input.toString()).toBe('http://localhost:3099/api/workspaces/test-session-id/canvases')
      expect(init?.method).toBe('POST')
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
      expect(init?.body).toBe(JSON.stringify({ slug: 'test-canvas', overwrite: false }))
      return new Response(JSON.stringify({ slug: 'test-canvas' }), { status: 200 })
    }) as typeof globalThis.fetch

    try {
      await expect(tool.execute({ slug: 'test-canvas' }, 'test-session-id', client)).resolves.toEqual({
        id: 'test-session-id/test-canvas',
        url: 'http://localhost:3099/canvas/test-session-id/test-canvas',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('case 98', async () => {
    const tool = createCanvasTool()
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.body).toBe(JSON.stringify({ slug: '123-my-canvas', overwrite: false }))
      return new Response(JSON.stringify({ slug: '123-my-canvas' }), { status: 200 })
    }) as typeof globalThis.fetch

    try {
      await expect(
        tool.execute({ slug: 'my-canvas', issueNumber: 123 }, 'test-session-id', client),
      ).resolves.toMatchObject({ id: 'test-session-id/123-my-canvas' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('case 99', async () => {
    const tool = createCanvasTool()
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ message: 'Canvas "duplicate" already exists' }), { status: 409 }),
    ) as typeof globalThis.fetch

    try {
      await expect(tool.execute({ slug: 'duplicate' }, 'test-session-id', client)).rejects.toThrow(
        /already exists/,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('canvas_list', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-mcp-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('case 100', async () => {
    const tool = listCanvasTool()
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      if (input.toString() === 'http://localhost:3099/api/workspaces') {
        return new Response(
          JSON.stringify({
            workspaces: [
              { workspaceId: 'active-session' },
              { workspaceId: 'stale-session' },
            ],
          }),
          { status: 200 },
        )
      }
      if (input.toString() === 'http://localhost:3099/api/workspaces/active-session/canvases') {
        return new Response(
          JSON.stringify({
            canvases: [
              { slug: '621-Header', updatedAt: '2026-04-23T00:00:00.000Z' },
              { slug: 'footer', updatedAt: '2026-04-23T00:01:00.000Z' },
            ],
          }),
          { status: 200 },
        )
      }
      if (input.toString() === 'http://localhost:3099/api/workspaces/stale-session/canvases') {
        return new Response(
          JSON.stringify({
            canvases: [{ slug: 'unrelated', updatedAt: '2026-04-23T00:02:00.000Z' }],
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${input.toString()}`)
    }) as typeof globalThis.fetch

    try {
      const { workspaces } = await tool.execute({ slugContains: 'header' }, client)
      expect(workspaces).toHaveLength(1)
      expect(workspaces[0].workspaceId).toBe('active-session')
      expect(workspaces[0].canvases.map((c) => c.slug)).toEqual(['621-Header'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
describe('canvas_open', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('case 101', async () => {
    const openMock = vi.fn(async () => undefined)
    vi.doMock('open', () => ({ default: openMock }))
    const { openCanvasTool } = await import('./canvas.js')
    const tool = openCanvasTool()
    const res = await tool.execute({ id: 'sid/slug' }, client)
    expect(res.url).toBe('http://localhost:3099/canvas/sid/slug')
    expect(openMock).toHaveBeenCalledWith('http://localhost:3099/canvas/sid/slug')
  })

  it('case 102', async () => {
    // Use a URL hash, not a query string, for fullscreen.
    //
    // When the browser already has the canvas open, opening the same path
    // with a different query (`?fullscreen=1`) is treated as a navigation:
    // the page unloads and `beforeunload` fires (e.g. the dirty-state
    // dialog the WorkspaceTopBar registers). Fragment-only changes fire
    // `hashchange` instead — no unload, no dialog. CanvasPage listens for
    // both forms on mount so cold opens still work.
    const openMock = vi.fn(async () => undefined)
    vi.doMock('open', () => ({ default: openMock }))
    const { openCanvasTool } = await import('./canvas.js')
    const tool = openCanvasTool()
    const res = await tool.execute({ id: 'sid/slug', fullscreen: true }, client)
    expect(res.url).toBe('http://localhost:3099/canvas/sid/slug#fullscreen')
    expect(openMock).toHaveBeenCalledWith('http://localhost:3099/canvas/sid/slug#fullscreen')
  })

  it('case 103', async () => {
    const openMock = vi.fn(async () => undefined)
    vi.doMock('open', () => ({ default: openMock }))
    const { openCanvasTool } = await import('./canvas.js')
    const tool = openCanvasTool()
    const res = await tool.execute({ id: 'sid/slug', fullscreen: false }, client)
    expect(res.url).toBe('http://localhost:3099/canvas/sid/slug')
    expect(openMock).toHaveBeenCalledWith('http://localhost:3099/canvas/sid/slug')
  })

  it('case 104', async () => {
    vi.doMock('open', () => ({ default: vi.fn(async () => undefined) }))
    let polls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      expect(url.toString()).toBe(
        'http://localhost:3099/api/canvas/sid/slug/client-count',
      )
      polls += 1
      const readyCount = polls >= 3 ? 1 : 0
      return new Response(JSON.stringify({ count: 1, readyCount }), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    try {
      const { openCanvasTool } = await import('./canvas.js')
      const tool = openCanvasTool()
      const res = await tool.execute(
        { id: 'sid/slug', waitForClient: true, waitTimeoutMs: 2000 },
        client,
      )
      expect(res.url).toBe('http://localhost:3099/canvas/sid/slug')
      expect(res.clientReady).toBe(true)
      expect(polls).toBeGreaterThanOrEqual(3)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('case 105', async () => {
    vi.doMock('open', () => ({ default: vi.fn(async () => undefined) }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ count: 1, readyCount: 0 }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch
    try {
      const { openCanvasTool } = await import('./canvas.js')
      const tool = openCanvasTool()
      const res = await tool.execute(
        { id: 'sid/slug', waitForClient: true, waitTimeoutMs: 300 },
        client,
      )
      expect(res.clientReady).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('case 106', async () => {
    const openMock = vi.fn(async () => undefined)
    vi.doMock('open', () => ({ default: openMock }))
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    try {
      const { openCanvasTool } = await import('./canvas.js')
      const tool = openCanvasTool()
      const res = await tool.execute({ id: 'sid/slug' }, client)
      expect(res).toEqual({ url: 'http://localhost:3099/canvas/sid/slug' })
      expect(openMock).toHaveBeenCalledWith('http://localhost:3099/canvas/sid/slug')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('case 107', async () => {
    vi.doMock('open', () => ({ default: vi.fn(async () => Promise.reject(new Error('boom'))) }))
    const { openCanvasTool } = await import('./canvas.js')
    const tool = openCanvasTool()
    const res = await tool.execute({ id: 'sid/slug' }, client)
    expect(res).toEqual({ url: 'http://localhost:3099/canvas/sid/slug', openFailed: 'boom' })
  })
})

describe('optimize_canvases', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-mcp-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('hits the per-canvas /compact endpoint when slug is given and wraps the result', async () => {
    const tool = optimizeCanvasesTool()
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(input.toString()).toBe(
        'http://localhost:3099/api/workspaces/sid/canvases/canvas-a/compact',
      )
      expect(init?.method).toBe('POST')
      return new Response(
        JSON.stringify({ compacted: true, beforeBytes: 2048, afterBytes: 512, reason: 'ok' }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch

    try {
      await expect(tool.execute({ slug: 'canvas-a' }, 'sid', client)).resolves.toEqual({
        results: [
          { slug: 'canvas-a', compacted: true, beforeBytes: 2048, afterBytes: 512, reason: 'ok' },
        ],
        totalBeforeBytes: 2048,
        totalAfterBytes: 512,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('hits /optimize-all when slug is omitted and returns the aggregated payload', async () => {
    const tool = optimizeCanvasesTool()
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(input.toString()).toBe(
        'http://localhost:3099/api/workspaces/sid/canvases/optimize-all',
      )
      expect(init?.method).toBe('POST')
      return new Response(
        JSON.stringify({
          results: [
            { slug: 'a', compacted: true, beforeBytes: 1000, afterBytes: 200, reason: 'ok' },
            { slug: 'b', compacted: false, beforeBytes: 500, afterBytes: 500, reason: 'no-gain' },
          ],
          totalBeforeBytes: 1500,
          totalAfterBytes: 700,
        }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch

    try {
      const res = await tool.execute({}, 'sid', client)
      expect(res.results).toHaveLength(2)
      expect(res.totalBeforeBytes).toBe(1500)
      expect(res.totalAfterBytes).toBe(700)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('throws on a non-2xx response so callers get a clear failure', async () => {
    const tool = optimizeCanvasesTool()
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'workspace missing' }), { status: 404 }),
    ) as typeof globalThis.fetch
    try {
      await expect(tool.execute({}, 'sid', client)).rejects.toThrow(/optimize|workspace missing/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
