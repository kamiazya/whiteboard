import { describe, expect, it } from 'vitest'
import { isDatabaseBusy } from './database-busy.js'

describe('isDatabaseBusy', () => {
  it('reads the primary code', () => {
    expect(isDatabaseBusy(Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' }))).toBe(true)
  })

  it('reads an extended code libsql reports beside a generic primary one', () => {
    const err = Object.assign(new Error('locked'), {
      code: 'SQLITE_ERROR',
      extendedCode: 'SQLITE_BUSY_SNAPSHOT',
    })
    expect(isDatabaseBusy(err)).toBe(true)
  })

  it('answers false for another code, a value with no code, and a non-object', () => {
    expect(isDatabaseBusy(Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT' }))).toBe(false)
    expect(isDatabaseBusy(new Error('x'))).toBe(false)
    expect(isDatabaseBusy('SQLITE_BUSY')).toBe(false)
    expect(isDatabaseBusy(null)).toBe(false)
  })
})
