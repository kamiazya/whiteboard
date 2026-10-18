import { describe, expect, it } from 'vitest'
import {
  PROMOTE_MAX_TRASH,
  PROMOTE_MAX_VERSIONS,
  type PromoteWorkspaceResponse,
  promoteWorkspaceRequestSchema,
  promoteWorkspaceResponseSchema,
} from './promotion.js'
import { roundtrip } from './roundtrip.test-helper.js'

describe('promotion schemas', () => {
  it('roundtrips a bare request, and refuses a padded snapshot or a key it does not name', () => {
    const bare = { snapshot: 'c25hcHNob3Q' }
    expect(roundtrip(promoteWorkspaceRequestSchema, bare)).toEqual(bare)
    // No keeper holds a passkey pin to check one against (ADR-0050 decision 3).
    const attestation = { kind: 'webauthn', credentialId: 'Y3JlZA' }
    expect(promoteWorkspaceRequestSchema.safeParse({ ...bare, attestation }).success).toBe(false)
    expect(promoteWorkspaceRequestSchema.safeParse({ snapshot: 'c25hcA==' }).success).toBe(false)
    expect(promoteWorkspaceRequestSchema.safeParse({ ...bare, label: 'x' }).success).toBe(false)
  })

  it('roundtrips the trash bytes and version rows a move carries beside the record', () => {
    const version = {
      id: '01BRWVERSAAAAAAAAAAAAAAAA0',
      documentId: '01BRWAAAAAAAAAAAAAAAAAAAA0',
      createdAt: 1_000,
      auto: false,
      label: 'as drafted',
      operator: { kind: 'human' as const, displayName: 'Yuki' },
      frontiers: 'AQID',
    }
    const carried = {
      snapshot: 'c25hcHNob3Q',
      trash: [{ documentId: '01BRWAAAAAAAAAAAAAAAAAAAA1', bytes: 'Ynl0ZXM' }],
      versions: [version],
    }
    expect(roundtrip(promoteWorkspaceRequestSchema, carried)).toEqual(carried)
    const refused = (versions: unknown[]) =>
      promoteWorkspaceRequestSchema.safeParse({ ...carried, versions }).success
    // A device the keeper cannot back with a key is not carried in.
    expect(refused([{ ...version, operator: { kind: 'human', actor: 'did:key:z6Mk' } }])).toBe(
      false,
    )
    // An id the daemon's version store could not key a row by.
    expect(refused([{ ...version, id: 'not/an/id' }])).toBe(false)
    expect(refused([{ ...version, label: '' }])).toBe(false)
  })

  it('takes as many trash entries and versions as one move carries, and refuses one more', () => {
    const version = {
      id: 'v',
      documentId: '01BRWAAAAAAAAAAAAAAAAAAAA0',
      createdAt: 1,
      auto: true,
      frontiers: 'AA',
    }
    const trashed = { documentId: '01BRWAAAAAAAAAAAAAAAAAAAA1', bytes: 'AA' }
    const takes = (body: object) =>
      promoteWorkspaceRequestSchema.safeParse({ snapshot: 'c25hcHNob3Q', ...body }).success
    expect(takes({ versions: Array(PROMOTE_MAX_VERSIONS).fill(version) })).toBe(true)
    expect(takes({ versions: Array(PROMOTE_MAX_VERSIONS + 1).fill(version) })).toBe(false)
    expect(takes({ trash: Array(PROMOTE_MAX_TRASH).fill(trashed) })).toBe(true)
    expect(takes({ trash: Array(PROMOTE_MAX_TRASH + 1).fill(trashed) })).toBe(false)
  })

  it('roundtrips the response', () => {
    const valid: PromoteWorkspaceResponse = {
      ok: true,
      recorded: ['01BRWAAAAAAAAAAAAAAAAAAAA0'],
      shadowed: [],
      trashStored: ['01BRWAAAAAAAAAAAAAAAAAAAA1'],
      versionsKept: ['01BRWVERSAAAAAAAAAAAAAAAA0'],
    }
    expect(roundtrip(promoteWorkspaceResponseSchema, valid)).toEqual(valid)
    expect(promoteWorkspaceResponseSchema.safeParse({ ...valid, ok: false }).success).toBe(false)
    // A landed move must not read as failed because a newer daemon says more.
    const withExtra = promoteWorkspaceResponseSchema.safeParse({ ...valid, mergedAt: 'later' })
    expect(withExtra.success && withExtra.data).toEqual(valid)
    // A keeper that does not say what it holds is read as holding none of it,
    // which keeps the sender's copy rather than deleting it on a guess.
    const { trashStored: _trash, versionsKept: _versions, ...silent } = valid
    expect(promoteWorkspaceResponseSchema.parse(silent)).toEqual({
      ...valid,
      trashStored: [],
      versionsKept: [],
    })
  })
})
