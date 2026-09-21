/**
 * Roundtrip + refusal tests for the read plane's workspace-key wire contract
 * (ADR-0042 decisions 1/3/5, ADR-0043 decision 3).
 */
import { describe, expect, it } from 'vitest'
import {
  type ReplicaKeyResponse,
  type RotateReplicaKeyResponse,
  replicaKeyResponseSchema,
  replicaTierSchema,
  rotateReplicaKeyResponseSchema,
  type SetReplicaTierRequest,
  type SetReplicaTierResponse,
  setReplicaTierRequestSchema,
  setReplicaTierResponseSchema,
} from './replica-key.js'
import { roundtrip } from './roundtrip.test-helper.js'

const KEY_43 = 'A'.repeat(43)
const SALT_22 = 'B'.repeat(22)
const KEY_ID_22 = 'C'.repeat(22)

describe('replicaTierSchema', () => {
  it('accepts every declared tier', () => {
    for (const tier of ['no-offline', 'offline', 'bounded'] as const) {
      expect(replicaTierSchema.safeParse(tier).success).toBe(true)
    }
  })

  it('rejects an unknown tier', () => {
    expect(replicaTierSchema.safeParse('full-offline').success).toBe(false)
  })
})

describe('replicaKeyResponseSchema', () => {
  const offline: ReplicaKeyResponse = {
    workspaceKey: KEY_43,
    workspaceKeySalt: SALT_22,
    tier: 'offline',
  }
  const bounded: ReplicaKeyResponse = {
    ...offline,
    tier: 'bounded',
    leaseExpiresAt: '2026-09-28T00:00:00.000Z',
  }

  it('roundtrips an offline response with no leaseExpiresAt', () => {
    expect(roundtrip(replicaKeyResponseSchema, offline)).toEqual(offline)
  })

  it('roundtrips a bounded response with leaseExpiresAt', () => {
    expect(roundtrip(replicaKeyResponseSchema, bounded)).toEqual(bounded)
  })

  it('rejects a bounded response with no leaseExpiresAt', () => {
    expect(replicaKeyResponseSchema.safeParse({ ...offline, tier: 'bounded' }).success).toBe(false)
  })

  it('rejects an offline/no-offline response carrying a leaseExpiresAt', () => {
    for (const tier of ['offline', 'no-offline'] as const) {
      expect(
        replicaKeyResponseSchema.safeParse({
          ...offline,
          tier,
          leaseExpiresAt: '2026-09-28T00:00:00.000Z',
        }).success,
      ).toBe(false)
    }
  })

  it('rejects a workspaceKey that decodes to 31 or 33 bytes, accepts 32', () => {
    expect(
      replicaKeyResponseSchema.safeParse({ ...offline, workspaceKey: 'A'.repeat(42) }).success,
    ).toBe(false)
    expect(
      replicaKeyResponseSchema.safeParse({ ...offline, workspaceKey: 'A'.repeat(44) }).success,
    ).toBe(false)
    expect(
      replicaKeyResponseSchema.safeParse({ ...offline, workspaceKey: 'A'.repeat(43) }).success,
    ).toBe(true)
  })

  it('rejects a 21-char salt', () => {
    expect(
      replicaKeyResponseSchema.safeParse({ ...offline, workspaceKeySalt: 'B'.repeat(21) }).success,
    ).toBe(false)
  })

  it('rejects an unknown tier', () => {
    expect(replicaKeyResponseSchema.safeParse({ ...offline, tier: 'full-offline' }).success).toBe(
      false,
    )
  })

  // ADR-0043 decision 3: a document's epoch lives beside its own ciphertext
  // (read-plane.ts's sealedEnvelopeSchema), never on the workspace key —
  // .strict() is what refuses a caller that tries to fold one in here.
  it('rejects a response carrying an epoch field', () => {
    expect(replicaKeyResponseSchema.safeParse({ ...offline, epoch: 0 }).success).toBe(false)
  })

  // keyId is OPTIONAL, not required: a daemon that predates rotation
  // answers this route with no keyId at all, and a browser bundle newer
  // than that daemon must still parse the response (the reverse skew — an
  // older bundle against a keyId-carrying daemon — is the accepted cost;
  // see the ADR-0042 addendum).
  it('roundtrips a response with keyId, and parses one with keyId absent', () => {
    expect(roundtrip(replicaKeyResponseSchema, { ...offline, keyId: KEY_ID_22 })).toEqual({
      ...offline,
      keyId: KEY_ID_22,
    })
    expect(replicaKeyResponseSchema.safeParse(offline).success).toBe(true)
  })

  it('rejects a keyId of the wrong length', () => {
    expect(replicaKeyResponseSchema.safeParse({ ...offline, keyId: 'C'.repeat(21) }).success).toBe(
      false,
    )
  })
})

describe('rotateReplicaKeyResponseSchema', () => {
  it('roundtrips a rotation response', () => {
    const response: RotateReplicaKeyResponse = { keyId: KEY_ID_22 }
    expect(roundtrip(rotateReplicaKeyResponseSchema, response)).toEqual(response)
  })

  it('rejects a missing keyId', () => {
    expect(rotateReplicaKeyResponseSchema.safeParse({}).success).toBe(false)
  })

  it('rejects a malformed keyId', () => {
    expect(rotateReplicaKeyResponseSchema.safeParse({ keyId: 'not-base64url!' }).success).toBe(
      false,
    )
  })

  it('rejects an undeclared field (.strict()) — no key bytes or salt may ride along', () => {
    expect(
      rotateReplicaKeyResponseSchema.safeParse({ keyId: KEY_ID_22, workspaceKey: KEY_43 }).success,
    ).toBe(false)
  })
})

describe('setReplicaTierRequestSchema', () => {
  it('accepts every declared tier and the explicit clear', () => {
    for (const tier of ['no-offline', 'offline', 'bounded', null] as const) {
      const request: SetReplicaTierRequest = { tier }
      expect(roundtrip(setReplicaTierRequestSchema, request)).toEqual(request)
    }
  })

  it('rejects an unknown tier', () => {
    expect(setReplicaTierRequestSchema.safeParse({ tier: 'full-offline' }).success).toBe(false)
  })

  it('rejects a missing tier field', () => {
    expect(setReplicaTierRequestSchema.safeParse({}).success).toBe(false)
  })

  it('rejects an undeclared field (.strict()) — no lease TTL or epoch may ride along', () => {
    expect(
      setReplicaTierRequestSchema.safeParse({ tier: 'bounded', leaseExpiresAt: '2026-09-28' })
        .success,
    ).toBe(false)
  })
})

describe('setReplicaTierResponseSchema', () => {
  it('roundtrips a set response', () => {
    const response: SetReplicaTierResponse = { tier: 'no-offline', effectiveTier: 'no-offline' }
    expect(roundtrip(setReplicaTierResponseSchema, response)).toEqual(response)
  })

  it('roundtrips a cleared response, where tier is null but effectiveTier still resolves', () => {
    const response: SetReplicaTierResponse = { tier: null, effectiveTier: 'offline' }
    expect(roundtrip(setReplicaTierResponseSchema, response)).toEqual(response)
  })

  it('rejects a response with no effectiveTier (never optional — a clear still resolves one)', () => {
    expect(setReplicaTierResponseSchema.safeParse({ tier: null }).success).toBe(false)
  })
})
