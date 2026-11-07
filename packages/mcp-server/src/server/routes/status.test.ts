import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { resolvingDocumentIds } from './_test-helpers.js'

vi.mock('../sync-audience.js', () => ({
  getClientCount: vi.fn(),
  getReadyClientCount: vi.fn(),
}))

const { getClientCount } = await import('../sync-audience.js')
const { getReadyClientCount } = await import('../sync-audience.js')
const { createStatusRouter } = await import('./status.js')

const WS = '01M8BBN7JS60N0ZAR13NP8SXBF'
const DOC = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const UNHELD = '01BX5ZZKBKACTAV9WEVGEMMVRY'

function makeApp() {
  const app = new Hono()
  resolvingDocumentIds(app, { [DOC]: { path: 'canvas-a' } })
  app.route('/', createStatusRouter())
  return app
}

const url = (documentId: string, workspaceId = WS) =>
  `/api/workspaces/${workspaceId}/documents/${documentId}/client-count`

describe('GET /api/workspaces/:workspaceId/documents/:documentId/client-count', () => {
  it('returns count=0 when no clients are connected', async () => {
    ;(getClientCount as unknown as ReturnType<typeof vi.fn>).mockReturnValue(0)
    ;(getReadyClientCount as unknown as ReturnType<typeof vi.fn>).mockReturnValue(0)
    const res = await makeApp().request(url(DOC))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { count: number; readyCount: number }
    expect(body.count).toBe(0)
    expect(body.readyCount).toBe(0)
  })

  it('returns count and readyCount so connected-but-not-ready tabs stay distinguishable', async () => {
    ;(getClientCount as unknown as ReturnType<typeof vi.fn>).mockReturnValue(2)
    ;(getReadyClientCount as unknown as ReturnType<typeof vi.fn>).mockReturnValue(1)
    const res = await makeApp().request(url(DOC))
    const body = (await res.json()) as { count: number; readyCount: number }
    expect(body.count).toBe(2)
    expect(body.readyCount).toBe(1)
  })

  it('returns 400 for a malformed workspace handle', async () => {
    const res = await makeApp().request(url(DOC, 'bad.sid'))
    expect(res.status).toBe(400)
  })

  it('returns 404 for an id no document holds', async () => {
    const res = await makeApp().request(url(UNHELD))
    expect(res.status).toBe(404)
  })
})
