import { describe, expect, it } from 'vitest'
import { resolveStartupTimeoutMs } from './ensure-daemon.js'

// The packaged daemon cold-start (native modules, WASM, first-run migrations)
// can exceed the 10s default on slow CI runners; the env override lets the
// release gate wait longer without changing local/production behavior.
describe('resolveStartupTimeoutMs', () => {
  it('defaults to 10s when no override or env var is set', () => {
    expect(resolveStartupTimeoutMs({})).toBe(10_000)
  })

  it('prefers the explicit option override over the env var', () => {
    expect(resolveStartupTimeoutMs({ WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS: '60000' }, 5_000)).toBe(
      5_000,
    )
  })

  it('reads WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS from env', () => {
    expect(resolveStartupTimeoutMs({ WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS: '60000' })).toBe(60_000)
  })

  it.each([
    ['non-numeric', 'abc'],
    ['zero', '0'],
    ['negative', '-5000'],
    ['fractional', '1000.5'],
    ['empty', ''],
  ])('falls back to the default for %s env value', (_label, value) => {
    expect(resolveStartupTimeoutMs({ WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS: value })).toBe(10_000)
  })
})
