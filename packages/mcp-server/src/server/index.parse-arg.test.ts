import { describe, expect, it } from 'vitest'
import { parseArg } from './index.js'

describe('parseArg', () => {
  it('returns the flag value when present once', () => {
    expect(parseArg(['--idle-timeout-ms=4000'], 'idle-timeout-ms')).toBe('4000')
  })

  it('returns the fallback when the flag is absent', () => {
    expect(parseArg([], 'idle-timeout-ms', '900000')).toBe('900000')
  })

  it('returns undefined when the flag is absent and no fallback is given', () => {
    expect(parseArg([], 'idle-timeout-ms')).toBeUndefined()
  })

  it('duplicate flags: the FIRST occurrence wins (Array.find semantics)', () => {
    // Unlike resolveToken's --token= handling (last-wins, via reverse().find),
    // parseArg uses a plain forward find(), so a caller's own value wins over
    // one a wrapper appends later.
    expect(parseArg(['--idle-timeout-ms=4000', '--idle-timeout-ms=5000'], 'idle-timeout-ms')).toBe(
      '4000',
    )
  })
})
