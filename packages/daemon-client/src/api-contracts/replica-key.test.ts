/**
 * Roundtrip + refusal tests for the read plane's workspace-key wire contract
 * (ADR-0042 decisions 1/3/5, ADR-0043 decision 3).
 */
import { describe, expect, it } from 'vitest'
import {
  type ReplicaKeyResponse,
  replicaKeyResponseSchema,
  replicaTierSchema,
} from './replica-key.js'
import { roundtrip } from './roundtrip.test-helper.js'

const KEY_43 = 'A'.repeat(43)
const SALT_22 = 'B'.repeat(22)

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
})
