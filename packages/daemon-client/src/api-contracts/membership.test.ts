/**
 * Roundtrip serialization tests for the membership api-contract schemas
 * (ADR-0041). Each schema gets a valid-fixture roundtrip plus a refusal per
 * constraint the `.strict()` shape declares.
 */

import { apiErrorBodySchema, apiErrorReason } from '@kamiazya/whiteboard-server-core'
import { describe, expect, it } from 'vitest'
import {
  type AddMemberRequest,
  addMemberRequestSchema,
  type ListMembersResponse,
  listMembersResponseSchema,
  type MemberProfileSummary,
  memberProfileSummarySchema,
  membershipRefusalSchema,
  removeMemberResponseSchema,
} from './membership.js'
import { roundtrip } from './roundtrip.test-helper.js'

describe('memberProfileSummarySchema', () => {
  const valid: MemberProfileSummary = {
    profileId: '01J9Z8QK2N3X4Y5Z6A7B8C9D0E',
    displayName: 'Ada Lovelace',
    credentials: [
      { credentialId: 'Y3JlZC0x', origin: 'https://a.example' },
      { credentialId: 'Y3JlZC0y', origin: 'https://b.example' },
    ],
    createdAt: '2026-09-20T00:00:00.000Z',
  }

  it('roundtrips a well-formed profile with two credentials', () => {
    const result = roundtrip(memberProfileSummarySchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects an empty displayName', () => {
    expect(memberProfileSummarySchema.safeParse({ ...valid, displayName: '' }).success).toBe(false)
  })

  it('rejects a credential carrying its public key (never travels on the wire)', () => {
    expect(
      memberProfileSummarySchema.safeParse({
        ...valid,
        credentials: [{ ...valid.credentials[0], publicKey: 'MFkwEw...' }],
      }).success,
    ).toBe(false)
  })

  it('rejects a profile-level extra field carrying a public key', () => {
    expect(
      memberProfileSummarySchema.safeParse({ ...valid, publicKeyJwk: { kty: 'EC' } }).success,
    ).toBe(false)
  })

  it('rejects a credential missing origin', () => {
    const { origin: _omit, ...credentialMissingOrigin } = valid.credentials[0] as {
      credentialId: string
      origin: string
    }
    expect(
      memberProfileSummarySchema.safeParse({
        ...valid,
        credentials: [credentialMissingOrigin],
      }).success,
    ).toBe(false)
  })
})

describe('listMembersResponseSchema', () => {
  const member: MemberProfileSummary = {
    profileId: '01J9Z8QK2N3X4Y5Z6A7B8C9D0E',
    displayName: 'Ada Lovelace',
    credentials: [{ credentialId: 'Y3JlZC0x', origin: 'https://a.example' }],
    createdAt: '2026-09-20T00:00:00.000Z',
  }
  const valid: ListMembersResponse = { members: [member, { ...member, profileId: 'x2' }] }

  it('roundtrips a list of members', () => {
    expect(roundtrip(listMembersResponseSchema, valid)).toEqual(valid)
  })

  it('roundtrips an empty list', () => {
    const empty: ListMembersResponse = { members: [] }
    expect(roundtrip(listMembersResponseSchema, empty)).toEqual(empty)
  })

  it('rejects an extra top-level field', () => {
    expect(listMembersResponseSchema.safeParse({ ...valid, total: 2 }).success).toBe(false)
  })
})

describe('addMemberRequestSchema', () => {
  const valid: AddMemberRequest = {
    credentialId: 'Y3JlZC0x',
    origin: 'https://a.example',
    displayName: 'Ada Lovelace',
  }

  it('roundtrips a well-formed request', () => {
    expect(roundtrip(addMemberRequestSchema, valid)).toEqual(valid)
  })

  it('rejects an empty displayName', () => {
    expect(addMemberRequestSchema.safeParse({ ...valid, displayName: '' }).success).toBe(false)
  })

  it('rejects a 121-char displayName and accepts 120', () => {
    expect(
      addMemberRequestSchema.safeParse({ ...valid, displayName: 'x'.repeat(121) }).success,
    ).toBe(false)
    expect(
      addMemberRequestSchema.safeParse({ ...valid, displayName: 'x'.repeat(120) }).success,
    ).toBe(true)
  })

  it('rejects a missing origin', () => {
    const { origin: _omit, ...missing } = valid
    expect(addMemberRequestSchema.safeParse(missing).success).toBe(false)
  })

  it('rejects an extra publicKey field', () => {
    expect(addMemberRequestSchema.safeParse({ ...valid, publicKey: 'MFkw...' }).success).toBe(false)
  })
})

describe('removeMemberResponseSchema', () => {
  it('roundtrips sessionsEnded 0 and 3', () => {
    expect(roundtrip(removeMemberResponseSchema, { removed: true, sessionsEnded: 0 })).toEqual({
      removed: true,
      sessionsEnded: 0,
    })
    expect(roundtrip(removeMemberResponseSchema, { removed: true, sessionsEnded: 3 })).toEqual({
      removed: true,
      sessionsEnded: 3,
    })
  })

  it('rejects a negative sessionsEnded', () => {
    expect(removeMemberResponseSchema.safeParse({ removed: true, sessionsEnded: -1 }).success).toBe(
      false,
    )
  })

  it('rejects a fractional sessionsEnded', () => {
    expect(
      removeMemberResponseSchema.safeParse({ removed: true, sessionsEnded: 1.5 }).success,
    ).toBe(false)
  })

  it('rejects removed: false', () => {
    expect(removeMemberResponseSchema.safeParse({ removed: false, sessionsEnded: 0 }).success).toBe(
      false,
    )
  })

  it('rejects an extra profileId field', () => {
    expect(
      removeMemberResponseSchema.safeParse({ removed: true, sessionsEnded: 0, profileId: 'x' })
        .success,
    ).toBe(false)
  })
})

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
