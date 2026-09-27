/**
 * While a remembered daemon's reconnection is in flight, the session's keeper
 * is undecided. Rendering the browser's own workspace meanwhile opens an
 * address that may name the DAEMON's document — the two keepers can share a
 * workspace segment — and the browser page then leads somewhere else before
 * the reconnection lands. A reconnection through the extension waits for the
 * native host to start, so that window is no longer a single round trip.
 */
import { describe, expect, it } from 'vitest'
import { renewalPending } from './session-keeper.js'

describe('renewalPending', () => {
  it('holds while a reconnection is in flight and nothing has answered', () => {
    expect(renewalPending({ forcedBrowser: false, awaitingDaemonRenewal: true, grant: null })).toBe(
      true,
    )
  })

  it.each([
    [
      'the person chose the browser',
      { forcedBrowser: true, awaitingDaemonRenewal: true, grant: null },
    ],
    [
      'no reconnection is under way',
      { forcedBrowser: false, awaitingDaemonRenewal: false, grant: null },
    ],
    // An outcome that is not a connection — a changed identity — keeps its
    // own warning on the browser screen rather than waiting forever.
    [
      'the reconnection answered',
      { forcedBrowser: false, awaitingDaemonRenewal: true, grant: { status: 'identity-mismatch' } },
    ],
  ])('does not hold when %s', (_why, input) => {
    expect(renewalPending(input)).toBe(false)
  })
})
