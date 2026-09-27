/**
 * ADR-0050: a daemon reached through the whiteboard extension is one more
 * address to `createDaemonFetch`, so every surface that builds its own
 * daemon fetch reaches it without being told how.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonFetch } from './daemon-auth-fetch.js'
import { BRIDGE_DAEMON_BASE_URL } from './extension-bridge-fetch.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createDaemonFetch to the extension bridge', () => {
  it('goes through the extension rather than the network', async () => {
    const sent: Array<{ type: string; id: string; path?: string }> = []
    let answer: (m: unknown) => void = () => {}
    const port = {
      onMessage: {
        addListener: (l: (m: unknown) => void) => {
          answer = l
        },
      },
      onDisconnect: { addListener: () => {} },
      postMessage: (m: { type: string; id: string; path?: string }) => {
        sent.push(m)
        answer({ type: 'head', id: m.id, status: 200, headers: {} })
        answer({ type: 'end', id: m.id })
      },
      disconnect: () => {},
    }
    vi.stubGlobal('chrome', { runtime: { connect: () => port, sendMessage: () => {} } })
    const network = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', network)

    // A caller handing its own network fetch in — `daemon.fetch ?? fetch`, a
    // bound global — still reaches the bridge: nothing on a network answers
    // this address, so the network is never the right transport for it.
    const res = await createDaemonFetch(
      BRIDGE_DAEMON_BASE_URL,
      undefined,
      network,
    )('/api/workspaces')

    expect(res.status).toBe(200)
    expect(sent).toEqual([expect.objectContaining({ type: 'request', path: '/api/workspaces' })])
    expect(network).not.toHaveBeenCalled()
  })
})
