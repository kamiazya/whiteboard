// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { DaemonApiError } from './daemon-api-client.js'
import { membershipRefusal } from './membership-refusal.js'

describe('membershipRefusal', () => {
  it('answers the code for a not_a_member refusal, regardless of the message sentence', () => {
    const err = new DaemonApiError('irrelevant text', 403, {
      error: 'not_a_member',
      message: 'anything else',
    })
    expect(membershipRefusal(err)).toBe('not_a_member')
  })

  it('answers null for a requires_person_session refusal: no passkey here can bind a session', () => {
    const err = new DaemonApiError('irrelevant text', 403, {
      error: 'requires_person_session',
      message: 'session is not bound',
    })
    expect(membershipRefusal(err)).toBeNull()
  })

  it('answers null for a membership refusal code this slice does not act on, even carrying the classifier sentence', () => {
    const err = new DaemonApiError('irrelevant text', 403, {
      error: 'workspace_not_found',
      message: 'this session is not signed in as a member',
    })
    expect(membershipRefusal(err)).toBeNull()
  })

  // The daemon may be newer than this bundle and say more than it knows.
  it('still reads the code of a refusal that carries a key it does not know', () => {
    const err = new DaemonApiError('irrelevant text', 403, {
      error: 'not_a_member',
      message: 'm',
      extra: 'from a newer daemon',
    })
    expect(membershipRefusal(err)).toBe('not_a_member')
  })

  it('answers null for a 404 DaemonApiError', () => {
    const err = new DaemonApiError('not found', 404, undefined)
    expect(membershipRefusal(err)).toBeNull()
  })

  it('answers null for a plain Error', () => {
    expect(membershipRefusal(new Error('boom'))).toBeNull()
  })

  // Metamorphic: the classifier reads the CODE only. Matching the message
  // sentence instead is exactly the regression this guards — mutation-check:
  // replacing the schema-parse with a message match fails this for any
  // message other than the one sentence that mutation hardcodes.
  fcTest.prop([fc.string({ minLength: 1 })], withDefaults())(
    'is constant in the message, for a fixed code',
    (message) => {
      const err = new DaemonApiError('irrelevant', 403, { error: 'not_a_member', message })
      expect(membershipRefusal(err)).toBe('not_a_member')
    },
  )
})
