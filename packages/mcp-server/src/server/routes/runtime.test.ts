import { describe, expect, it, vi } from 'vitest'
import { createRuntimeRouter } from './runtime.js'

function createApp() {
  const touch = vi.fn()
  const shutdown = vi.fn(async () => undefined)
  const app = createRuntimeRouter({
    token: 'secret',
    touch,
    shutdown,
    getStatus: () => ({
      pid: 10,
      port: 3099,
      startedAt: '2026-04-23T00:00:00.000Z',
      uptimeMs: 100,
      idleForMs: 50,
      connectedClients: 2,
      readyClients: 1,
    }),
  })

  return { app, touch, shutdown }
}

describe('runtime routes', () => {
  it('allows unauthenticated ping', async () => {
    const { app } = createApp()
    const res = await app.request('/api/runtime/ping')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ ok: true })
  })

  it('rejects status without a bearer token', async () => {
    const { app } = createApp()
    const res = await app.request('/api/runtime/status')
    expect(res.status).toBe(401)
  })

  it('returns runtime status with authorization', async () => {
    const { app, touch } = createApp()
    const res = await app.request('/api/runtime/status', {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      pid: 10,
      port: 3099,
      connectedClients: 2,
      readyClients: 1,
    })
    expect(touch).toHaveBeenCalledTimes(1)
  })

  it('schedules shutdown when authenticated', async () => {
    const { app, shutdown, touch } = createApp()
    const res = await app.request('/api/runtime/shutdown', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(200)
    expect(touch).toHaveBeenCalledTimes(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('returns a storage report for an authenticated GET /api/runtime/storage', async () => {
    const { app, touch } = createApp()
    const res = await app.request('/api/runtime/storage', {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      totalBytes: number
      fileCount: number
      byCategory: Record<string, { bytes: number; files: number }>
      lastAutoCompactedAt: number | null
    }
    expect(typeof body.totalBytes).toBe('number')
    expect(typeof body.fileCount).toBe('number')
    expect(body.byCategory.blobs).toBeDefined()
    expect(body.byCategory.versions).toBeDefined()
    expect(body.byCategory.files).toBeDefined()
    expect(body.byCategory.libraries).toBeDefined()
    expect(body.byCategory.db).toBeDefined()
    expect(body.byCategory.other).toBeDefined()
    // Locked: storage report always carries the auto-compact timestamp so
    // the UI can render "Auto-optimised Ns ago" without a second fetch.
    // Null is the legitimate "never auto-compacted" state.
    expect(body.lastAutoCompactedAt === null || typeof body.lastAutoCompactedAt === 'number').toBe(
      true,
    )
    expect(touch).toHaveBeenCalledTimes(1)
  })

  it('rejects /api/runtime/storage without a bearer token', async () => {
    const { app } = createApp()
    const res = await app.request('/api/runtime/storage')
    expect(res.status).toBe(401)
  })

  it('rejects POST /api/runtime/logs/prune without a bearer token', async () => {
    // Mutating runtime route — must be authenticated when the daemon was
    // started with a token. The global daemon-mutation middleware in app.ts
    // explicitly excludes /api/runtime/*, so the per-router middleware is
    // the only thing standing between an unauthenticated request and the
    // log-deletion side effect.
    const { app } = createApp()
    const res = await app.request('/api/runtime/logs/prune', { method: 'POST' })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('unauthorized')
  })

  it('allows POST /api/runtime/logs/prune with the bearer token', async () => {
    // Sanity: confirm the route still functions for an authenticated caller.
    // This is what the Storage tab Cleanup affordance hits.
    const { app } = createApp()
    const res = await app.request('/api/runtime/logs/prune', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(200)
  })
})
