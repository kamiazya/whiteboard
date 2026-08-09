// The fake daemon's bind retry, tested directly rather than through the
// hook subprocess. Driving it end-to-end would mean racing wall-clock
// sleeps against a spawned process — a test that passes when the collision
// it meant to create never happened. Here the collision is constructed, so
// each case is deterministic.
import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startFakeMcpResponder } from './fake-mcp-daemon.mjs'

const HOST = '127.0.0.1'

const openServers: Server[] = []

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await new Promise<void>((closed) => server.close(() => closed()))
  }
})

/** Binds a port and returns it still held, plus a release function. */
async function occupyAPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const squatter = createServer((socket) => socket.destroy())
  openServers.push(squatter)
  await new Promise<void>((listening) => squatter.listen(0, HOST, () => listening()))
  const address = squatter.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    release: () => new Promise<void>((closed) => squatter.close(() => closed())),
  }
}

describe('startFakeMcpResponder bind retry', () => {
  it('rides out a collision that clears within the budget', async () => {
    const { port, release } = await occupyAPort()
    // Let go while the responder is still retrying — the common shape of the
    // race on a shared CI runner is something else mid-teardown, and losing
    // a job to that would be a flake, not a signal.
    setTimeout(() => void release(), 250)

    const responder = await startFakeMcpResponder({ port, token: 'tok' })
    openServers.push(responder.server)
    expect(responder.server.listening).toBe(true)
  })

  it('rejects with EADDRINUSE when the port never frees up', async () => {
    const { port } = await occupyAPort()
    await expect(startFakeMcpResponder({ port, token: 'tok' })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    })
  })

  it('binds immediately when the port is free', async () => {
    const { port, release } = await occupyAPort()
    await release()

    const started = Date.now()
    const responder = await startFakeMcpResponder({ port, token: 'tok' })
    openServers.push(responder.server)
    // No retry budget is spent on the happy path.
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('answers an authenticated POST /mcp and refuses anything else', async () => {
    const { port, release } = await occupyAPort()
    await release()
    const responder = await startFakeMcpResponder({ port, token: 'tok' })
    openServers.push(responder.server)
    const url = `http://${HOST}:${port}/mcp`

    const ok = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer tok' } })
    expect(ok.status).toBe(200)
    const unauthorized = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer x' },
    })
    expect(unauthorized.status).toBe(401)
    const wrongRoute = await fetch(`http://${HOST}:${port}/nope`, { method: 'POST' })
    expect(wrongRoute.status).toBe(404)
  })
})
