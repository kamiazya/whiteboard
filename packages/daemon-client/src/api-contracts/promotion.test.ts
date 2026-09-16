import { describe, expect, it } from 'vitest'
import {
  type PromoteWorkspaceRequest,
  type PromoteWorkspaceResponse,
  promoteWorkspaceRequestSchema,
  promoteWorkspaceResponseSchema,
  promotionChallengeInput,
} from './promotion.js'
import { roundtrip } from './roundtrip.test-helper.js'

describe('promotion schemas', () => {
  const attestation = {
    kind: 'webauthn' as const,
    credentialId: 'Y3JlZA',
    authenticatorData: 'YXV0aA',
    clientDataJSON: 'Y2xpZW50',
    signature: 'c2ln',
  }

  it('roundtrips a request with and without an attestation, and refuses a padded snapshot', () => {
    const bare: PromoteWorkspaceRequest = { snapshot: 'c25hcHNob3Q' }
    expect(roundtrip(promoteWorkspaceRequestSchema, bare)).toEqual(bare)
    const attested: PromoteWorkspaceRequest = { ...bare, attestation }
    expect(roundtrip(promoteWorkspaceRequestSchema, attested)).toEqual(attested)
    expect(promoteWorkspaceRequestSchema.safeParse({ snapshot: 'c25hcA==' }).success).toBe(false)
    expect(promoteWorkspaceRequestSchema.safeParse({ ...bare, label: 'x' }).success).toBe(false)
  })

  it('roundtrips the response', () => {
    const valid: PromoteWorkspaceResponse = {
      ok: true,
      attested: true,
      recorded: ['01BRWAAAAAAAAAAAAAAAAAAAA0'],
      shadowed: [],
    }
    expect(roundtrip(promoteWorkspaceResponseSchema, valid)).toEqual(valid)
    expect(promoteWorkspaceResponseSchema.safeParse({ ...valid, ok: false }).success).toBe(false)
  })

  it('the challenge input is one JSON array with the tag first, so parts cannot run together', () => {
    const a = promotionChallengeInput({ workspaceId: 'ab', snapshotDigest: 'c' })
    const b = promotionChallengeInput({ workspaceId: 'a', snapshotDigest: 'bc' })
    expect(new TextDecoder().decode(a)).toBe('["wb-promote-v1","ab","c"]')
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
  })
})
