import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { createServerSpy } = vi.hoisted(() => ({ createServerSpy: vi.fn() }))

// Partial mock: keep the real node:net surface (BlockList etc. used elsewhere in
// the import graph) and override only createServer.
vi.mock('node:net', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:net')>()
  return { ...real, createServer: createServerSpy }
})

const { findAvailablePort } = await import('./daemon-run.js')

// A minimal net.Server stand-in: EventEmitter for .on()/.emit() plus the
// listen/close/address surface findAvailablePort touches. Mocking createServer
// drives the 'error' path deterministically without binding real ports, which is
// flaky under parallel runs and restricted CI sandboxes.
function fakeServer(opts: { errorCode?: string; port?: number }) {
  const server = new EventEmitter() as EventEmitter & {
    listen: (port: number, host: string, cb: () => void) => void
    close: (cb?: () => void) => void
    address: () => { port: number }
  }
  server.listen = (_port, _host, cb) => {
    queueMicrotask(() => {
      if (opts.errorCode) {
        server.emit('error', Object.assign(new Error(opts.errorCode), { code: opts.errorCode }))
      } else {
        cb()
      }
    })
  }
  server.close = (cb?: () => void) => cb?.()
  server.address = () => ({ port: opts.port ?? 0 })
  return server
}

describe('findAvailablePort', () => {
  afterEach(() => vi.clearAllMocks())

  it('rejects immediately on a non-EADDRINUSE error and does not scan further ports', async () => {
    createServerSpy.mockImplementation(() => fakeServer({ errorCode: 'EACCES' }))
    await expect(findAvailablePort(4000)).rejects.toMatchObject({ code: 'EACCES' })
    // A permanent error must stop the scan at the first port, not walk ~62k ports.
    expect(createServerSpy).toHaveBeenCalledTimes(1)
  })

  it('retries the next port on EADDRINUSE until one binds', async () => {
    let call = 0
    createServerSpy.mockImplementation(() => {
      call += 1
      return call === 1 ? fakeServer({ errorCode: 'EADDRINUSE' }) : fakeServer({ port: 5005 })
    })
    await expect(findAvailablePort(5004)).resolves.toBe(5005)
    expect(createServerSpy).toHaveBeenCalledTimes(2)
  })
})
