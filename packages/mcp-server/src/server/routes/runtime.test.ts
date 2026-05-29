import { describe, expect, it, vi } from 'vitest'
import { runtimeStatusResponseSchema, type RuntimeStatusResponse } from '../../shared/api-contracts/runtime.js'
import { createRuntimeRouter } from './runtime.js'

function createApp() {
  const touch = vi.fn()
  const shutdown = vi.fn(async () => undefined)
  const app = createRuntimeRouter({
    token: 'secret',
    touch,
    shutdown,
    getStatus: () => ({
      ok: true,
      pid: 10,
      host: '127.0.0.1',
      port: 3099,
      baseUrl: 'http://127.0.0.1:3099',
      version: '0.0.0',
      startedAt: '2026-04-23T00:00:00.000Z',
      uptimeMs: 100,
      idleForMs: 50,
      auth: { mode: 'local-token', hasToken: true },
      storage: { dataDir: '/tmp/data', dataDirWritable: true },
      app: { served: true, buildPresent: false },
      mcp: { httpEnabled: true, endpoint: 'http://127.0.0.1:3099/mcp' },
      clients: { connected: 2, ready: 1 },
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
      clients: { connected: 2, ready: 1 },
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

  it('status response conforms to runtimeStatusResponseSchema (parse does not throw)', async () => {
    const { app } = createApp()
    const res = await app.request('/api/runtime/status', {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(() => runtimeStatusResponseSchema.parse(body)).not.toThrow()
  })
})
