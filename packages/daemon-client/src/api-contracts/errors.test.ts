import { describe, expect, it } from 'vitest'
import { apiErrorBodySchema, apiErrorReason } from './errors.js'

describe('apiErrorBodySchema', () => {
  it.each([
    [{ title: 'Canvas not found' }],
    [{ error: 'branch_conflict' }],
    [{ error: 'branch_conflict', message: 'A variation named "x" already exists' }],
  ])('accepts %j', (body) => {
    expect(apiErrorBodySchema.safeParse(body).success).toBe(true)
  })

  it.each([
    // An out-of-contract body must FAIL to parse: the previous
    // title-optional schema accepted every object, which is exactly how a
    // reason spelled differently got silently discarded.
    [{}],
    [{ oops: 1 }],
    [{ title: '' }],
    [{ message: 'reason without a code' }],
    [null],
    ['plain string'],
  ])('rejects %j', (body) => {
    expect(apiErrorBodySchema.safeParse(body).success).toBe(false)
  })
})

describe('apiErrorReason', () => {
  it('returns the title for the Problem Details arm', () => {
    expect(apiErrorReason({ title: 'Canvas "x" already exists' })).toBe('Canvas "x" already exists')
  })

  it('returns the message for the code+reason arm', () => {
    expect(apiErrorReason({ error: 'branch_conflict', message: 'already exists' })).toBe(
      'already exists',
    )
  })

  it('returns undefined for a bare code and for out-of-contract bodies', () => {
    expect(apiErrorReason({ error: 'branch_conflict' })).toBeUndefined()
    expect(apiErrorReason({ oops: 1 })).toBeUndefined()
    expect(apiErrorReason(undefined)).toBeUndefined()
  })
})
