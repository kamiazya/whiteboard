import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'

vi.mock('./ws.js', () => ({
  getClientCount: vi.fn(),
  getReadyClientCount: vi.fn(),
}))

const { getClientCount } = await import('./ws.js')
const { getReadyClientCount } = await import('./ws.js')
const { createStatusRouter } = await import('./status.js')

describe('GET /api/canvas/:sessionId/:slug/client-count', () => {
  it('returns count=0 when no clients are connected', async () => {
    ;(getClientCount as unknown as ReturnType<typeof vi.fn>).mockReturnValue(0)
    ;(getReadyClientCount as unknown as ReturnType<typeof vi.fn>).mockReturnValue(0)
    const app = new Hono()
    app.route('/', createStatusRouter())
    const res = await app.request('/api/canvas/s1/canvas-a/client-count')
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
    const res = await app.request('/api/canvas/s1/canvas-a/client-count')
    const body = (await res.json()) as { count: number; readyCount: number }
    expect(body.count).toBe(2)
    expect(body.readyCount).toBe(1)
  })

  it('returns 400 for invalid sessionId / slug', async () => {
    const app = new Hono()
    app.route('/', createStatusRouter())

    const badSession = await app.request('/api/canvas/bad.sid/canvas-a/client-count')
    expect(badSession.status).toBe(400)

    const badSlug = await app.request('/api/canvas/s1/bad.slug/client-count')
    expect(badSlug.status).toBe(400)
  })
})
