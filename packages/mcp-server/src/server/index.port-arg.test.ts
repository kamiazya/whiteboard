import { describe, expect, it } from 'vitest'
import { parseArg } from './index.js'

describe('parseArg', () => {
  it('returns the flag value when present once', () => {
    expect(parseArg(['--port=4000'], 'port')).toBe('4000')
  })

  it('returns the fallback when the flag is absent', () => {
    expect(parseArg([], 'port', '3099')).toBe('3099')
  })

  it('returns undefined when the flag is absent and no fallback is given', () => {
    expect(parseArg([], 'port')).toBeUndefined()
  })

  it('duplicate --port flags: the FIRST occurrence wins (Array.find semantics)', () => {
    // Unlike resolveToken's --token= handling (last-wins, via reverse().find),
    // readArg/parseArg uses a plain forward find(), so the first flag wins.
    // with-dev-data-dir.mjs relies on this asymmetry being unchanged: it only
    // appends its derived --port when argv has none, so a caller-provided
    // --port is never duplicated in practice — but if that guard ever regressed,
    // first-wins here would silently keep the caller's original value, not the
    // newly appended one.
    expect(parseArg(['--port=4000', '--port=5000'], 'port')).toBe('4000')
  })
})
