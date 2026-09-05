import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AsyncAuthStrategy } from './security/oauth-resource-strategy.js'

// vi.mock is hoisted above imports, so mutable state shared with the mocks
// must be initialised with vi.hoisted() to avoid a temporal dead-zone error.
const { mockServe, getLastServer } = vi.hoisted(() => {
  type MockServer = EventEmitter & { listening: boolean; close: ReturnType<typeof vi.fn> }
  let lastServer: MockServer | null = null

  const mockServe = vi.fn(() => {
    const emitter = new EventEmitter() as MockServer
    emitter.listening = false
    emitter.close = vi.fn((cb?: (err?: Error) => void) => {
      cb?.()
    })
    lastServer = emitter
    return emitter
  })

  return { mockServe, getLastServer: () => lastServer }
})

vi.mock('@hono/node-server', () => ({ serve: mockServe }))
vi.mock('./app.js', () => ({ createApp: vi.fn(() => ({ fetch: vi.fn() })) }))
// The root now builds real ServerDeps before createApp (the /api/v1 mount
// fix); this unit harness is about listen/close mechanics, so the store
// layer is stubbed — unmocked, ensureWorkspaceId/getDb would open the
// contributor's real data dir and time the test out.
vi.mock('./current-workspace.js', () => ({ ensureWorkspaceId: vi.fn(async () => 'ws') }))
vi.mock('./store/db/index.js', () => ({ getDb: vi.fn(async () => ({})) }))
vi.mock('../di/container.js', () => ({
  createContainer: vi.fn(() => ({})),
  resolveServerDeps: vi.fn(() => ({})),
}))
vi.mock('../di/store-local.module.js', () => ({ createStoreLocalModule: vi.fn(() => ({})) }))

import { createApp } from './app.js'
import { startServerModeHttp } from './server-mode-http.js'

function makeOptions() {
  return {
    host: '127.0.0.1',
    port: 9001,
    publicBaseUrl: 'http://127.0.0.1:9001',
    allowedOrigins: [] as readonly string[],
    authStrategy: {} as AsyncAuthStrategy,
  }
}

/**
 * The mock server, once startServerModeHttp has actually reached serve().
 * The root now awaits its ServerDeps construction first, so lastServer is
 * null for a few microtasks after the call — reading it synchronously (the
 * old pattern) hands the test a null and the 'listening' emit goes nowhere.
 */
async function serverOnceServing() {
  await vi.waitFor(() => {
    expect(mockServe).toHaveBeenCalled()
  })
  const server = getLastServer()
  expect(server).not.toBeNull()
  return server!
}

describe('startServerModeHttp', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('resolves with port, host, startedAt, resolvedDataDir, and close on successful startup', async () => {
    const options = makeOptions()
    const startPromise = startServerModeHttp(options)
    const server = await serverOnceServing()
    setImmediate(() => server.emit('listening'))

    const result = await startPromise

    expect(result.port).toBe(options.port)
    expect(result.host).toBe(options.host)
    expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(typeof result.resolvedDataDir).toBe('string')
    expect(result.close).toBeTypeOf('function')
  })

  it('close() calls server.close() exactly once and resolves', async () => {
    const options = makeOptions()
    const startPromise = startServerModeHttp(options)
    const server = await serverOnceServing()
    setImmediate(() => server.emit('listening'))
    const { close } = await startPromise

    await close()

    expect(server.close).toHaveBeenCalledTimes(1)
  })

  it('close() is idempotent — subsequent calls do nothing', async () => {
    const options = makeOptions()
    const startPromise = startServerModeHttp(options)
    const server = await serverOnceServing()
    setImmediate(() => server.emit('listening'))
    const { close } = await startPromise

    await close()
    await close()
    await close()

    expect(server.close).toHaveBeenCalledTimes(1)
  })

  it('wires getStatus() to report the always-available server-placeholder UI', async () => {
    const options = makeOptions()
    const startPromise = startServerModeHttp(options)
    const server = await serverOnceServing()
    setImmediate(() => server.emit('listening'))
    await startPromise

    const createAppMock = vi.mocked(createApp)
    const passedOptions = createAppMock.mock.calls.at(-1)?.[0]
    const status = passedOptions?.getStatus()

    // Server-mode ships the placeholder page inline in app.ts (not a build
    // artifact), so these fields are fixed rather than derived from a
    // filesystem check.
    expect(status?.app).toEqual({
      served: true,
      buildPresent: true,
      ui: 'server-placeholder',
    })
  })

  /**
   * Server mode is the MULTI-INSTANCE deployment, and until this it was the
   * one taking no garbage collection at all — uploads that no document
   * references any more accumulated forever, with the sweeper declared and
   * `worker: null`.
   *
   * The reason it stayed unarmed was a question about running a deleter with
   * several instances against one data directory, and the answer is that
   * nothing about the pass is single-instance: it catches up on the record
   * before deciding, fences on the position it decided at, stands down while
   * a backup is assembling the directory, and leaves anything younger than
   * the grace window alone. Two passes racing the same file is the benign
   * half — the loser's unlink answers ENOENT and is logged and skipped.
   */
  it('arms the file-GC sweeper, and stops it when the server closes', async () => {
    const sweeper = { start: vi.fn(), tick: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const startPromise = startServerModeHttp({
      ...makeOptions(),
      fileGcSweeperFactory: () => sweeper,
    })
    const server = await serverOnceServing()
    setImmediate(() => server.emit('listening'))
    const { close } = await startPromise

    expect(sweeper.start).toHaveBeenCalledTimes(1)

    await close()

    // With a cap, not bare: a full pass can be expensive and shutdown must
    // not wait out the whole of one.
    expect(sweeper.stop).toHaveBeenCalledWith({ timeoutMs: 5_000 })
  })

  it('rejects when the server emits an error before listening', async () => {
    const options = makeOptions()
    const startPromise = startServerModeHttp(options)
    const server = await serverOnceServing()
    const portError = Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' })
    setImmediate(() => server.emit('error', portError))

    await expect(startPromise).rejects.toThrow('EADDRINUSE')
  })
})
