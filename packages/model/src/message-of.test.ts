import { describe, expect, it } from 'vitest'
import { describeThrown, messageOf } from './message-of.js'

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

describe('describeThrown', () => {
  it("answers an Error's own message, and its name when the message is empty", () => {
    expect(describeThrown(new Error('disk full'))).toBe('disk full')
    expect(describeThrown(new TypeError(''))).toBe('TypeError')
  })

  it('answers a thrown primitive as its string form', () => {
    expect(describeThrown('boom')).toBe('boom')
    expect(describeThrown(undefined)).toBe('undefined')
    expect(describeThrown(null)).toBe('null')
    expect(describeThrown(42)).toBe('42')
  })

  it('names what a thrown plain object carries instead of "[object Object]"', () => {
    const text = describeThrown({ code: 'x' })
    expect(text).toContain('code')
    expect(text).not.toContain('[object Object]')
  })

  it('answers an object JSON cannot write as its type', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(describeThrown(cyclic)).toBe('object')
  })

  it('caps what a large thrown object writes', () => {
    const text = describeThrown({ blob: 'a'.repeat(10_000) })
    expect(text.length).toBeLessThan(1_000)
    expect(text.endsWith('…')).toBe(true)
  })
})
