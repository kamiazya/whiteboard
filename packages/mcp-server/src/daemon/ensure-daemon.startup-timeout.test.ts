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

  it('treats a blank value as unset rather than as a mistake', () => {
    expect(resolveStartupTimeoutMs({ WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS: '' })).toBe(10_000)
    expect(resolveStartupTimeoutMs({ WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS: '   ' })).toBe(10_000)
  })

  /**
   * These used to fall back to 10s. Whoever set this variable had a slow
   * environment in mind, so silently waiting the default instead delivers the
   * very failure they were trying to avoid — and the error that follows names
   * the daemon, not the setting, so nothing points at the real cause.
   *
   * Zero is an error rather than a meaning. Unlike the GC sweeps, where `0`
   * disables the pass, a zero timeout would mean "give up before looking".
   */
  it.each([
    ['non-numeric', 'abc'],
    ['zero', '0'],
    ['negative', '-5000'],
    ['fractional', '1000.5'],
    ['a unit suffix', '60s'],
  ])('throws rather than falling back for %s env value', (_label, value) => {
    expect(() => resolveStartupTimeoutMs({ WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS: value })).toThrow(
      /WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS/,
    )
  })

  it('never echoes the offending value', () => {
    try {
      resolveStartupTimeoutMs({ WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS: 'sekrit' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).not.toContain('sekrit')
    }
  })

  it('still lets an explicit option override an unusable env value', () => {
    // The option is the caller's own decision and does not come from the
    // operator's environment, so it wins without consulting the variable.
    expect(resolveStartupTimeoutMs({ WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS: 'abc' }, 5_000)).toBe(
      5_000,
    )
  })
})
