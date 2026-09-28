/**
 * While a remembered daemon's reconnection is in flight, the session's keeper
 * is undecided. Rendering the browser's own workspace meanwhile opens an
 * address that may name the DAEMON's document — the two keepers can share a
 * workspace segment — and the browser page then leads somewhere else before
 * the reconnection lands. A reconnection through the extension waits for the
 * native host to start, so that window is no longer a single round trip.
 */
import { describe, expect, it } from 'vitest'
import { renewalPending, settingsDaemon, shellDaemon } from './session-keeper.js'

describe('renewalPending', () => {
  it('holds while a reconnection is in flight and nothing has answered', () => {
    expect(
      renewalPending({ forcedBrowser: false, awaitingDaemonRenewal: true, connected: false }),
    ).toBe(true)
  })

  it.each([
    [
      'the person chose the browser',
      { forcedBrowser: true, awaitingDaemonRenewal: true, connected: false },
    ],
    [
      'no reconnection is under way',
      { forcedBrowser: false, awaitingDaemonRenewal: false, connected: false },
    ],
    [
      'the reconnection answered',
      { forcedBrowser: false, awaitingDaemonRenewal: true, connected: true },
    ],
  ])('does not hold when %s', (_why, input) => {
    expect(renewalPending(input)).toBe(false)
  })
})

// ADR-0050: the page holds no daemon token. A connection through the
// extension carries an empty one, and a configured daemon carries none.
describe('the daemon a session talks to', () => {
  const connection = { daemonBaseUrl: 'https://daemon.whiteboard.invalid', token: '' }

  it('is the reconnected one, over any configured daemon', () => {
    const effectiveState = { kind: 'daemon', daemonBaseUrl: 'http://127.0.0.1:3099' } as const
    expect(shellDaemon({ forcedBrowser: false, connection, effectiveState })).toEqual({
      baseUrl: 'https://daemon.whiteboard.invalid',
      token: '',
    })
    expect(
      settingsDaemon({ forcedBrowser: false, connection, providerState: effectiveState }),
    ).toEqual({ baseUrl: 'https://daemon.whiteboard.invalid', token: '' })
  })

  it('carries no token for a configured daemon', () => {
    const state = { kind: 'daemon', daemonBaseUrl: 'http://127.0.0.1:3099' } as const
    expect(shellDaemon({ forcedBrowser: false, connection: null, effectiveState: state })).toEqual({
      baseUrl: 'http://127.0.0.1:3099',
      token: undefined,
    })
    expect(
      settingsDaemon({ forcedBrowser: false, connection: null, providerState: state }),
    ).toEqual({ baseUrl: 'http://127.0.0.1:3099', token: null })
  })

  it('is none once the person chose the browser', () => {
    const effectiveState = { kind: 'browser' } as const
    expect(shellDaemon({ forcedBrowser: true, connection, effectiveState })).toBeUndefined()
    expect(
      settingsDaemon({ forcedBrowser: true, connection, providerState: effectiveState }),
    ).toBeUndefined()
  })
})
