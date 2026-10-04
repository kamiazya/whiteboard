/**
 * ADR-0050: a daemon reached through the whiteboard extension is one more
 * address to `createDaemonFetch`, so every surface that builds its own
 * daemon fetch reaches it without being told how.
 */
import { BRIDGE_PROTOCOL_VERSION } from '@kamiazya/whiteboard-daemon-client/extension-names'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_DAEMON_BASE_URL } from './bridge-address.js'
import { createDaemonFetch } from './daemon-auth-fetch.js'

// The page keeps ONE bridge port for its life; closing it is what lets the
// next test's stubbed extension be connected afresh, as a lost host is.
let dropPort: () => void = () => {}
afterEach(() => {
  dropPort()
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
      onDisconnect: {
        addListener: (l: () => void) => {
          dropPort = l
        },
      },
      postMessage: (m: { type: string; id: string; path?: string }) => {
        // The page asks the host its protocol once per connection; a host
        // that answers is not what this test is about, so it is answered
        // here and kept apart from the requests.
        if (m.type === 'hello') {
          answer({ type: 'hello', version: '0.0.0-test', protocol: BRIDGE_PROTOCOL_VERSION })
          return
        }
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
    const res = await createDaemonFetch(BRIDGE_DAEMON_BASE_URL, network)('/api/workspaces')

    expect(res.status).toBe(200)
    expect(sent).toEqual([expect.objectContaining({ type: 'request', path: '/api/workspaces' })])
    expect(network).not.toHaveBeenCalled()
  })
})
