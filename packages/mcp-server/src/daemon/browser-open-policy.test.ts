import { describe, expect, it } from 'vitest'
import { decideAutoOpenBrowser } from './browser-open-policy.js'

// Baseline: everything permissive. Individual tests flip exactly one input
// to isolate which guard is responsible for the resulting skip.
function baseInput() {
  return {
    isTTY: true,
    isContainer: false,
    env: {} as Readonly<Record<string, string | undefined>>,
    openOption: true,
  }
}

describe('decideAutoOpenBrowser', () => {
  it('opens when interactive, not a container, and not opted out', () => {
    expect(decideAutoOpenBrowser(baseInput())).toEqual({ shouldOpen: true })
  })

  it('skips when the caller opted out via --no-open or config', () => {
    expect(decideAutoOpenBrowser({ ...baseInput(), openOption: false })).toEqual({
      shouldOpen: false,
      reason: 'opted-out',
    })
  })

  it('skips when stdout is not an interactive TTY', () => {
    expect(decideAutoOpenBrowser({ ...baseInput(), isTTY: false })).toEqual({
      shouldOpen: false,
      reason: 'non-interactive',
    })
  })

  it('skips when CI env var is set, even on a TTY', () => {
    expect(decideAutoOpenBrowser({ ...baseInput(), env: { CI: 'true' } })).toEqual({
      shouldOpen: false,
      reason: 'ci',
    })
  })

  it('skips when running inside a container', () => {
    expect(decideAutoOpenBrowser({ ...baseInput(), isContainer: true })).toEqual({
      shouldOpen: false,
      reason: 'container',
    })
  })

  it('opted-out takes priority over other guards when multiple conditions fail', () => {
    expect(
      decideAutoOpenBrowser({
        ...baseInput(),
        openOption: false,
        isTTY: false,
        env: { CI: 'true' },
      }),
    ).toEqual({ shouldOpen: false, reason: 'opted-out' })
  })
})
