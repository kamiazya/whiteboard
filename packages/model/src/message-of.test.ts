import { describe, expect, it } from 'vitest'
import { messageOf } from './message-of.js'

describe('messageOf', () => {
  it("answers an Error's own message", () => {
    expect(messageOf(new Error('disk full'))).toBe('disk full')
    expect(messageOf(new TypeError('bad'))).toBe('bad')
  })

  it('answers the fallback for an Error that carries no message', () => {
    expect(messageOf(new Error(''), 'Could not save.')).toBe('Could not save.')
    expect(messageOf(new Error(''))).toBe('unknown error')
  })

  it('answers the fallback for anything thrown that is not an Error', () => {
    expect(messageOf('boom')).toBe('unknown error')
    expect(messageOf(undefined)).toBe('unknown error')
    expect(messageOf(null, 'nothing')).toBe('nothing')
    expect(messageOf({ message: 'looks like one' }, 'not an Error')).toBe('not an Error')
  })
})
