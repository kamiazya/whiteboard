/**
 * Roundtrip serialization tests for the membership refusal contract
 * (ADR-0041): a valid-fixture roundtrip plus a refusal per constraint the
 * `.strict()` shape declares.
 */

import { apiErrorBodySchema, apiErrorReason } from '@kamiazya/whiteboard-server-core/api-errors'
import { describe, expect, it } from 'vitest'
import { membershipRefusalSchema } from './membership.js'
import { roundtrip } from './roundtrip.test-helper.js'

describe('membershipRefusalSchema', () => {
  const codes = [
    'not_a_member',
    'unknown_credential',
    'unknown_profile',
    'unknown_workspace',
    'invalid_workspace_id',
    'requires_person_session',
    'replica_not_allowed',
  ] as const

  it.each(codes)('roundtrips the %s refusal', (error) => {
    const valid = { error, message: 'refused' }
    expect(roundtrip(membershipRefusalSchema, valid)).toEqual(valid)
  })

  it('rejects an unknown refusal code', () => {
    expect(membershipRefusalSchema.safeParse({ error: 'forbidden', message: 'x' }).success).toBe(
      false,
    )
  })

  it('rejects a missing message', () => {
    expect(membershipRefusalSchema.safeParse({ error: 'not_a_member' }).success).toBe(false)
  })

  it('rejects an empty message', () => {
    expect(membershipRefusalSchema.safeParse({ error: 'not_a_member', message: '' }).success).toBe(
      false,
    )
  })

  it('rejects an extra status field', () => {
    expect(
      membershipRefusalSchema.safeParse({ error: 'not_a_member', message: 'x', status: 403 })
        .success,
    ).toBe(false)
  })

  it('is a strict narrowing of apiErrorBodySchema: every valid refusal also parses there and apiErrorReason reads its message', () => {
    for (const error of codes) {
      const refusal = { error, message: `refused: ${error}` }
      expect(apiErrorBodySchema.safeParse(refusal).success).toBe(true)
      expect(apiErrorReason(refusal)).toBe(refusal.message)
    }
  })
})
