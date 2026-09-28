// @vitest-environment node
/**
 * ADR-0050: a cold load reconnects only to a daemon reached through the
 * extension. A remembered loopback address — written by the pairing flow this
 * app no longer has — is not reached at all, so nothing asks the network
 * whether something answers on that port.
 */
import { describe, expect, it } from 'vitest'
import { BRIDGE_DAEMON_BASE_URL } from '../lib/bridge-address.js'
import { storedDaemonForReconnect } from './use-daemon-reconnect.js'

describe('storedDaemonForReconnect', () => {
  it('reconnects a daemon remembered as reached through the extension', () => {
    expect(
      storedDaemonForReconnect({ providerKind: 'browser', storedBaseUrl: BRIDGE_DAEMON_BASE_URL }),
    ).toBe(BRIDGE_DAEMON_BASE_URL)
  })

  it.each([
    ['a remembered loopback address', 'browser', 'http://127.0.0.1:3099'],
    ['nothing remembered', 'browser', undefined],
    ['a keeper the runtime config already names', 'daemon', BRIDGE_DAEMON_BASE_URL],
  ] as const)('does not reconnect for %s', (_why, providerKind, storedBaseUrl) => {
    expect(storedDaemonForReconnect({ providerKind, storedBaseUrl })).toBeNull()
  })
})
