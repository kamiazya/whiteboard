import { describe, expect, it } from 'vitest'
import { isIsoDatetime } from './iso-datetime.js'

describe('isIsoDatetime', () => {
  it.each([
    '2026-03-04T05:06:07Z',
    '2026-03-04T05:06:07.089Z',
    '2026-03-04T05:06:07.1+09:00',
    '2026-03-04T05:06:07-05:30',
  ])('accepts %s', (value) => {
    expect(isIsoDatetime(value)).toBe(true)
  })

  it.each([
    '',
    '2026-03-04',
    '2026-03-04T05:06:07',
    '2026-03-04 05:06:07Z',
    'Authorization: Bearer abc',
    '2026-03-04T05:06:07Z\nextra',
  ])('rejects the shape %j', (value) => {
    expect(isIsoDatetime(value)).toBe(false)
  })

  it('rejects a value of the right shape that is not a date', () => {
    expect(isIsoDatetime('2026-13-40T00:00:00Z')).toBe(false)
  })
})
