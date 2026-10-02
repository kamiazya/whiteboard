import { describe, expect, it } from 'vitest'
import { errnoCode, isErrnoCode, isMissingFileError } from './errno.js'

function systemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe('errnoCode', () => {
  it('reads the code a system error carries', () => {
    expect(errnoCode(systemError('EEXIST'))).toBe('EEXIST')
  })

  it.each([
    null,
    undefined,
    'ENOENT',
    42,
    {},
    new Error('plain'),
    { code: 2 },
  ])('answers undefined, without throwing, for %j', (thrown) => {
    expect(errnoCode(thrown)).toBeUndefined()
  })
})

describe('isErrnoCode', () => {
  it('matches only the code asked for', () => {
    expect(isErrnoCode(systemError('EEXIST'), 'EEXIST')).toBe(true)
    expect(isErrnoCode(systemError('ENOENT'), 'EEXIST')).toBe(false)
  })

  it('is false for a throw that is not an object', () => {
    expect(isErrnoCode(null, 'EEXIST')).toBe(false)
    expect(isErrnoCode('EEXIST', 'EEXIST')).toBe(false)
  })
})

describe('isMissingFileError', () => {
  it('is ENOENT and nothing else', () => {
    expect(isMissingFileError(systemError('ENOENT'))).toBe(true)
    expect(isMissingFileError(systemError('EACCES'))).toBe(false)
    expect(isMissingFileError(null)).toBe(false)
  })
})
