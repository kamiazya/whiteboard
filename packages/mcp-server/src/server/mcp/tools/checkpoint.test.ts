import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('nanoid', () => ({
  nanoid: (size?: number) => (size ? 'cp0123456789abcdef'.slice(0, size) : 'cp0123456789abcdef'),
}))

const { checkpointSaveTool, checkpointRestoreTool } = await import('./checkpoint.js')

const client = {
  port: 3099,
  baseUrl: 'http://localhost:3099',
  request: (path: string, init?: RequestInit) =>
    globalThis.fetch(new URL(path, 'http://localhost:3099'), init),
  touch: async () => undefined,
}

describe('checkpoint_save', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('case 141', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(input.toString()).toBe('http://localhost:3099/api/workspaces/sess-1/checkpoints')
      expect(init?.method).toBe('POST')
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
      expect(init?.body).toBe(JSON.stringify({ sourceSlug: 'my-slug', checkpointId: 'cp0123456789abcdef' }))
      return new Response(JSON.stringify({ checkpointId: 'cp0123456789abcdef', elementCount: 2 }), { status: 200 })
    }) as typeof globalThis.fetch

    const tool = checkpointSaveTool()
    await expect(tool.execute({ canvasId: 'sess-1/my-slug' }, client)).resolves.toEqual({
      checkpointId: 'cp0123456789abcdef',
      elementCount: 2,
    })
  })

  it('case 142', async () => {
    globalThis.fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.body).toBe(JSON.stringify({ sourceSlug: 'slug', checkpointId: 'my-named-cp' }))
      return new Response(JSON.stringify({ checkpointId: 'my-named-cp', elementCount: 1 }), { status: 200 })
    }) as typeof globalThis.fetch

    const tool = checkpointSaveTool()
    await expect(tool.execute({ canvasId: 'sess-1/slug', id: 'my-named-cp' }, client)).resolves.toEqual({
      checkpointId: 'my-named-cp',
      elementCount: 1,
    })
  })

  it('case 143', async () => {
    const tool = checkpointSaveTool()
    await expect(
      tool.execute({ canvasId: 'sess-1/slug', id: '../bad' }, client),
    ).rejects.toThrow(/Invalid checkpoint id/)
  })

  it('case 144', async () => {
    const tool = checkpointSaveTool()
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Canvas "sess-1/missing" not found.' }), { status: 404 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'checkpoint save failed' }), { status: 500 }),
      ) as typeof globalThis.fetch

    await expect(tool.execute({ canvasId: 'sess-1/missing' }, client)).rejects.toThrow(/not found/i)
    await expect(tool.execute({ canvasId: 'sess-1/slug' }, client)).rejects.toThrow(/checkpoint save failed/i)
  })
})

describe('checkpoint_restore', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('case 145', async () => {
    const tool = checkpointRestoreTool()
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(input.toString()).toBe('http://localhost:3099/api/workspaces/sess-current/checkpoints/cp-known/restore')
      expect(init?.method).toBe('POST')
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
      expect(init?.body).toBe(JSON.stringify({ targetSlug: 'restored-canvas', overwrite: false }))
      return new Response(
        JSON.stringify({
          canvasId: 'sess-current/restored-canvas',
          elementCount: 2,
        }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch

    const res = await tool.execute({ checkpointId: 'cp-known', targetSlug: 'restored-canvas' }, 'sess-current', client)
    expect(res).toEqual({
      canvasId: 'sess-current/restored-canvas',
      url: 'http://localhost:3099/canvas/sess-current/restored-canvas',
      elementCount: 2,
    })
  })

  it('case 146', async () => {
    const tool = checkpointRestoreTool()
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ message: 'Checkpoint "doesnt-exist" not found' }), { status: 404 }),
    ) as typeof globalThis.fetch
    await expect(
      tool.execute({ checkpointId: 'doesnt-exist', targetSlug: 'x' }, 'sess-current', client),
    ).rejects.toThrow(/not found/i)
  })

  it('case 147', async () => {
    const tool = checkpointRestoreTool()
    globalThis.fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.body).toBe(JSON.stringify({ targetSlug: 'existing', overwrite: true }))
      return new Response(
        JSON.stringify({
          canvasId: 'sess-current/existing',
          elementCount: 1,
        }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch

    const res = await tool.execute({ checkpointId: 'cp-dup', targetSlug: 'existing', overwrite: true }, 'sess-current', client)
    expect(res.canvasId).toBe('sess-current/existing')
  })
})
