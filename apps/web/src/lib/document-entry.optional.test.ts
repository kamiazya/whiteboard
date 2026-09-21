import { describe, expect, it } from 'vitest'
import { optional } from './document-entry.js'

describe('optional', () => {
  it('carries a value under its key', () => {
    expect(optional('name', 'board')).toEqual({ name: 'board' })
  })

  // ABSENT, not present-as-undefined. Nineteen listing fields across the two
  // file sources spread this, and a row is compared and serialized — a key
  // holding `undefined` is a key, which `exactOptionalPropertyTypes` also
  // refuses at the type level. Mutating the guard away leaves every
  // files-source test green, which is why this one is here.
  it('omits the key entirely when there is no value', () => {
    const row = { path: 'a', ...optional('name', undefined) }
    expect('name' in row).toBe(false)
    expect(row).toEqual({ path: 'a' })
  })

  it('keeps a falsy value that is not undefined', () => {
    expect(optional('pinOrder', 0)).toEqual({ pinOrder: 0 })
    expect(optional('shadowed', false)).toEqual({ shadowed: false })
  })
})
