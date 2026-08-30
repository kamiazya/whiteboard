import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

// Mock ws.ts so each test can control getClientCount and sendViewportRequest.
const mockGetClientCount = vi.fn<(workspaceId: string, path: string) => number>()
const mockSendViewportRequest =
  vi.fn<
    (workspaceId: string, path: string, requestId: string, params: Record<string, unknown>) => void
  >()

vi.mock('./ws.js', () => ({
  getClientCount: (workspaceId: string, path: string) => mockGetClientCount(workspaceId, path),
  sendViewportRequest: (
    workspaceId: string,
    path: string,
    requestId: string,
    params: Record<string, unknown>,
  ) => mockSendViewportRequest(workspaceId, path, requestId, params),
}))

const { createViewportRouter, resolveViewportRequest } = await import('./viewport.js')

function makeApp(options: { timeoutMs?: number } = {}) {
  const app = new Hono()
  app.route('/', createViewportRouter(options))
  return app
}

describe('POST /api/w/:workspaceId/document/:path/viewport - error handling', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-viewport-test-'))
    mockGetClientCount.mockReset()
    mockSendViewportRequest.mockReset()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns 503 without waiting for the response timeout when there are no WS clients', async () => {
    // Pinned by the TIMEOUT the route was given, not by the wall clock. The
    // zero-client branch answers before the timer is ever armed, so a
    // regression into the waiting path would blow the per-test budget and
    // say so — where `elapsed < 500ms` instead measured how loaded the
    // machine was, and failed on CI at 721ms with nothing wrong.
    mockGetClientCount.mockReturnValue(0)
    const app = makeApp({ timeoutMs: 30_000 })

    const res = await app.request('/api/w/s1/document/canvas-a/viewport', { method: 'POST' })

    expect(res.status).toBe(503)
    expect(mockSendViewportRequest).not.toHaveBeenCalled()
  })

  /**
   * Asserts what the hint tells the caller to DO, not which tool to call.
   *
   * It used to require a tool name, which is how a hint kept naming one that
   * no longer existed. `mcp/mcp-guidance-tool-names.test.ts` fails if a tool
   * name comes back into this text.
   */
  it('tells the caller how to unblock itself, without naming a tool', async () => {
    mockGetClientCount.mockReturnValue(0)
    const app = makeApp()
    const res = await app.request('/api/w/s1/document/canvas-a/viewport', { method: 'POST' })
    const body = (await res.json()) as { error: string; message: string; hint?: string }
    expect(body.error).toBe('no_client')
    expect(body.message.toLowerCase()).toContain('no browser')
    expect(body.hint?.toLowerCase()).toContain('open the canvas in a browser')
  })

  it('returns 504 and a timeout error when a WS client does not respond', async () => {
    mockGetClientCount.mockReturnValue(1)
    const app = makeApp({ timeoutMs: 50 })

    const res = await app.request('/api/w/s1/document/canvas-a/viewport', { method: 'POST' })

    expect(res.status).toBe(504)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('timeout')
  })

  it('forwards mode="fit", elementIds, padding, and animate to sendViewportRequest', async () => {
    mockGetClientCount.mockReturnValue(1)
    mockSendViewportRequest.mockImplementation((_sid, _path, requestId) => {
      queueMicrotask(() => {
        resolveViewportRequest(requestId)
      })
    })
    const app = makeApp()

    const res = await app.request('/api/w/s1/document/canvas-a/viewport', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'fit',
        elementIds: ['a', 'b'],
        padding: 40,
        animate: true,
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    expect(mockSendViewportRequest).toHaveBeenCalledWith('s1', 'canvas-a', expect.any(String), {
      mode: 'fit',
      elementIds: ['a', 'b'],
      padding: 40,
      animate: true,
    })
  })

  it('forwards mode="move", scrollX, scrollY, and zoom to sendViewportRequest', async () => {
    mockGetClientCount.mockReturnValue(1)
    mockSendViewportRequest.mockImplementation((_sid, _path, requestId) => {
      queueMicrotask(() => resolveViewportRequest(requestId))
    })
    const app = makeApp()

    await app.request('/api/w/s1/document/canvas-a/viewport', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'move', scrollX: 100, scrollY: 200, zoom: 1.5 }),
    })

    expect(mockSendViewportRequest).toHaveBeenCalledWith('s1', 'canvas-a', expect.any(String), {
      mode: 'move',
      scrollX: 100,
      scrollY: 200,
      zoom: 1.5,
    })
  })

  it('returns 200 even without a request body', async () => {
    mockGetClientCount.mockReturnValue(1)
    mockSendViewportRequest.mockImplementation((_sid, _path, requestId) => {
      queueMicrotask(() => resolveViewportRequest(requestId))
    })
    const app = makeApp()

    const res = await app.request('/api/w/s1/document/canvas-a/viewport', { method: 'POST' })
    expect(res.status).toBe(200)
    // The browser side falls back to its default mode when the body is empty.
    const call = mockSendViewportRequest.mock.calls[0]
    expect(call[0]).toBe('s1')
    expect(call[1]).toBe('canvas-a')
    // At minimum, an empty object should be forwarded.
    expect(call[3]).toBeDefined()
  })

  it('clears the timeout timer once the WS client resolves early', async () => {
    mockGetClientCount.mockReturnValue(1)
    mockSendViewportRequest.mockImplementation((_sid, _path, requestId) => {
      queueMicrotask(() => resolveViewportRequest(requestId))
    })
    const app = makeApp({ timeoutMs: 5_000 })

    vi.useFakeTimers()
    try {
      const res = await app.request('/api/w/s1/document/canvas-a/viewport', { method: 'POST' })
      expect(res.status).toBe(200)
      // A leaked timer would still be pending here, ticking until timeoutMs.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns 400 for invalid workspaceId or path without reaching WS', async () => {
    mockGetClientCount.mockReturnValue(1)
    const app = makeApp()

    const badSession = await app.request('/api/w/bad.sid/document/canvas-a/viewport', {
      method: 'POST',
    })
    expect(badSession.status).toBe(400)

    const badPath = await app.request('/api/w/s1/document/bad.path/viewport', {
      method: 'POST',
    })
    expect(badPath.status).toBe(400)
    expect(mockSendViewportRequest).not.toHaveBeenCalled()
  })
})
