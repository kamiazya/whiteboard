import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./ws.js', () => ({
  getClientCount: vi.fn(),
  getReadyClientCount: vi.fn(),
}))

const { getClientCount } = await import('./ws.js')
const { getReadyClientCount } = await import('./ws.js')
const { createStatusRouter } = await import('./status.js')

describe('GET /api/w/:workspaceId/canvas/:path/client-count', () => {
  it('returns count=0 when no clients are connected', async () => {
    ;(getClientCount as unknown as ReturnType<typeof vi.fn>).mockReturnValue(0)
    ;(getReadyClientCount as unknown as ReturnType<typeof vi.fn>).mockReturnValue(0)
    const app = new Hono()
    app.route('/', createStatusRouter())
    const res = await app.request('/api/w/s1/canvas/canvas-a/client-count')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { count: number; readyCount: number }
    expect(body.count).toBe(0)
    expect(body.readyCount).toBe(0)
  })

  it('returns count and readyCount so connected-but-not-ready tabs stay distinguishable', async () => {
    ;(getClientCount as unknown as ReturnType<typeof vi.fn>).mockReturnValue(2)
    ;(getReadyClientCount as unknown as ReturnType<typeof vi.fn>).mockReturnValue(1)
    const app = new Hono()
    app.route('/', createStatusRouter())
    const res = await app.request('/api/w/s1/canvas/canvas-a/client-count')
    const body = (await res.json()) as { count: number; readyCount: number }
    expect(body.count).toBe(2)
    expect(body.readyCount).toBe(1)
  })

  it('returns 400 for invalid workspaceId / path', async () => {
    const app = new Hono()
    app.route('/', createStatusRouter())

    const badSession = await app.request('/api/w/bad.sid/canvas/canvas-a/client-count')
    expect(badSession.status).toBe(400)

    const badSlug = await app.request('/api/w/s1/canvas/bad.path/client-count')
    expect(badSlug.status).toBe(400)
  })
})
