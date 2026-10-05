import { describe, expect, it } from 'vitest'
import { isPermanentWriteRefusal, syncWriteRefusalOf } from './sync-write-refusal.js'

describe('isPermanentWriteRefusal', () => {
  it.each([400, 404, 409, 413, 422])('a %i refuses the bytes for good', (status) => {
    expect(isPermanentWriteRefusal(status)).toBe(true)
  })

  // A credential is renewed by a new session, 408 and 429 ask for a retry by
  // name, and a 5xx is the keeper's own trouble: each may land later.
  it.each([200, 401, 403, 408, 429, 500, 503])('a %i may land when sent again', (status) => {
    expect(isPermanentWriteRefusal(status)).toBe(false)
  })
})

describe('syncWriteRefusalOf', () => {
  it('reads a code the sync routes answer, with its sentence', () => {
    expect(syncWriteRefusalOf({ error: 'invalid_path', message: 'bad path' })).toEqual({
      code: 'invalid_path',
      message: 'bad path',
    })
  })

  it('keeps the sentence of a code this client does not know', () => {
    expect(syncWriteRefusalOf({ error: 'newer_rule', message: 'why' })).toEqual({
      code: null,
      message: 'why',
    })
  })

  it('answers an unreadable body as a refusal that says nothing', () => {
    expect(syncWriteRefusalOf(undefined)).toEqual({ code: null, message: '' })
  })
})
