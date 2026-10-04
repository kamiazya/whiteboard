/**
 * While a remembered daemon's reconnection is in flight, the session's keeper
 * is undecided. Rendering the browser's own workspace meanwhile opens an
 * address that may name the DAEMON's document — the two keepers can share a
 * workspace segment — and the browser page then leads somewhere else before
 * the reconnection lands. A reconnection through the extension waits for the
 * native host to start, so that window is no longer a single round trip.
 */
import { describe, expect, it } from 'vitest'
import { daemonForSession, renewalPending } from './session-keeper.js'

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

// ADR-0050: the page holds no daemon credential, so a resolved daemon is its
// address and nothing more.
describe('the daemon a session talks to', () => {
  const connection = { daemonBaseUrl: 'https://daemon.whiteboard.invalid' }
  const configured = { kind: 'daemon', daemonBaseUrl: 'https://configured.example' } as const

  it.each([
    [
      'is the reconnected one, over any configured daemon',
      connection,
      configured,
      'https://daemon.whiteboard.invalid',
    ],
    [
      'is the configured one when nothing reconnected',
      null,
      configured,
      'https://configured.example',
    ],
  ] as const)('%s', (_why, reconnected, providerState, baseUrl) => {
    expect(
      daemonForSession({ forcedBrowser: false, connection: reconnected, providerState }),
    ).toEqual({ baseUrl })
  })

  it.each([
    ['a reconnection', connection, configured],
    ['a configured daemon', null, configured],
  ] as const)('is none once the person chose the browser, over %s', (_why, reconnected, providerState) => {
    expect(
      daemonForSession({ forcedBrowser: true, connection: reconnected, providerState }),
    ).toBeUndefined()
  })

  it('is none when nothing names a daemon', () => {
    expect(
      daemonForSession({
        forcedBrowser: false,
        connection: null,
        providerState: { kind: 'browser' },
      }),
    ).toBeUndefined()
  })
})
