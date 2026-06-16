import { describe, it, expect } from 'vitest'
import { resolveToken } from './index.js'

describe('resolveToken', () => {
  it('returns the --token= arg value when present', () => {
    expect(resolveToken(['--token=my-arg-token'], {})).toBe('my-arg-token')
  })

  it('falls back to WHITEBOARD_TOKEN env var when --token is absent', () => {
    expect(resolveToken([], { WHITEBOARD_TOKEN: 'env-token' })).toBe('env-token')
  })

  it('returns undefined when neither --token nor WHITEBOARD_TOKEN is set', () => {
    expect(resolveToken([], {})).toBeUndefined()
  })

  it('--token takes precedence over WHITEBOARD_TOKEN env var', () => {
    expect(resolveToken(['--token=arg-wins'], { WHITEBOARD_TOKEN: 'env-loses' })).toBe('arg-wins')
  })

  it('preserves token values that contain "=" characters', () => {
    expect(resolveToken(['--token=abc=def'], {})).toBe('abc=def')
  })

  it('preserves token values with multiple "=" characters (e.g. base64url padding)', () => {
    expect(resolveToken(['--token=abc=='], {})).toBe('abc==')
  })

  it('prefers the last --token= flag so an appended override wins over a baked-in default', () => {
    // pnpm mcp:http:dev bakes in --token=whiteboard-dev; ensure-http-dev-daemon-lib
    // appends a custom token after it. The last value must win.
    expect(resolveToken(['--token=whiteboard-dev', '--token=custom-token'], {})).toBe(
      'custom-token',
    )
  })
})
