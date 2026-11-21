import { describe, expect, it } from 'vitest'
import { wireOf } from './value-wire.js'

describe('a string with a lone surrogate on the wire', () => {
  it('is refused by default, so a stored document value is never rewritten', () => {
    expect(wireOf('a\ud800b', 0)).toBeUndefined()
    expect(wireOf({ text: 'a\ud800b' }, 0)).toBeUndefined()
  })

  it('crosses as U+FFFD when the caller asks for the repair, in a value at any depth', () => {
    expect(wireOf('a\ud800b', 0, true, true)).toBe('a�b')
    expect(wireOf({ nodes: [{ text: 'x\udc00' }] }, 0, true, true)).toEqual([
      'm',
      'nodes',
      ['s', ['m', 'text', 'x�']],
    ])
  })

  it('still refuses a key with a lone surrogate, which a repair would merge with another', () => {
    expect(wireOf({ 'k\ud800': 1 }, 0, true, true)).toBeUndefined()
  })
})
