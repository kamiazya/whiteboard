/**
 * The wrapping half of cold-start offline (ADR-0042 decision 6): the
 * workspace key is persisted WRAPPED by a key derived from a passkey's `prf`
 * output, so what sits on disk is useless without the authenticator.
 *
 * Pure crypto, no DOM: the whole point of putting it here rather than in
 * `apps/web` is that it can be checked without a browser.
 */

import { describe, expect, it } from 'vitest'
import {
  deriveWrappingKey,
  unwrapWorkspaceKey,
  wrappedWorkspaceKeySchema,
  wrapWorkspaceKey,
} from './replica-key-wrap.js'

const PRF = new Uint8Array(32).fill(7)
const OTHER_PRF = new Uint8Array(32).fill(9)

const RESPONSE = {
  workspaceKey: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  workspaceKeySalt: 'AAECAwQFBgcICQoLDA0ODw',
  tier: 'offline' as const,
}

const BINDING = { daemonBaseUrl: 'http://127.0.0.1:3099', workspaceId: 'ws-1' }

describe('deriveWrappingKey', () => {
  it('answers the same key for the same prf output and a different one otherwise', async () => {
    const a = await wrapWorkspaceKey(await deriveWrappingKey(PRF), RESPONSE, BINDING)
    // Same PRF output, so a key derived again opens what the first sealed.
    expect(await unwrapWorkspaceKey(await deriveWrappingKey(PRF), a, BINDING)).toEqual(RESPONSE)
    expect(await unwrapWorkspaceKey(await deriveWrappingKey(OTHER_PRF), a, BINDING)).toBeNull()
  })

  it('refuses a prf output that is not the length WebAuthn specifies', async () => {
    await expect(deriveWrappingKey(new Uint8Array(16))).rejects.toThrow(RangeError)
  })
})

/**
 * A blob already stored in someone's browser must keep opening after any
 * change to this module. A wrap/unwrap round trip cannot say so: both halves
 * share the derivation, so a changed HKDF `info`, salt or binding layout moves
 * them together and the round trip stays green while every stored blob stops
 * opening.
 *
 * The blob below was sealed independently with node:crypto's `hkdfSync` and
 * `aes-256-gcm` (HKDF-SHA-256, empty salt, info `wb-replica-wrap-v1`, the
 * additional data as the JSON array ['wb-replica-wrap-v1', daemonBaseUrl,
 * workspaceId]) rather than by the code under test.
 */
describe('unwrapWorkspaceKey: known answer', () => {
  const KNOWN_PRF = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
  const KNOWN_BLOB = {
    v: 1 as const,
    iv: 'sLGys7S1tre4ubq7',
    ct: 'khJFN6YL3jBNTmyo7Ez0sqr4pJddw9mMHO1jgHEuCnvTP1_o7Ao0_TtTiIRkG_VMfPYpCwTyNGLFk0-2YTTpTOuTyt51zB7KZcnrFwbs4n_ksKS-VPd7XolBeFT2l7_TPBnvidwlF0946YVHWu0PJQJfCTwxqosrqkssfEkPwXIXJ5er8RXSiK6Z7g',
  }

  it('opens a blob sealed outside this module to the response it carried', async () => {
    const key = await deriveWrappingKey(KNOWN_PRF)
    expect(await unwrapWorkspaceKey(key, KNOWN_BLOB, BINDING)).toEqual(RESPONSE)
  })

  it('does not open it under a different authenticator output or binding', async () => {
    const key = await deriveWrappingKey(KNOWN_PRF)
    expect(await unwrapWorkspaceKey(await deriveWrappingKey(PRF), KNOWN_BLOB, BINDING)).toBeNull()
    expect(
      await unwrapWorkspaceKey(key, KNOWN_BLOB, { ...BINDING, workspaceId: 'ws-2' }),
    ).toBeNull()
  })
})

describe('wrapWorkspaceKey', () => {
  it('writes no part of the workspace key into the blob it produces', async () => {
    const blob = await wrapWorkspaceKey(await deriveWrappingKey(PRF), RESPONSE, BINDING)

    // The point of the feature: what lands on disk must not carry the key.
    // Checked as text because that is what the store writes.
    const serialized = JSON.stringify(blob)
    expect(serialized).not.toContain(RESPONSE.workspaceKey)
    expect(serialized).not.toContain(RESPONSE.workspaceKeySalt)
  })

  it('produces a fresh iv each time, so two wraps of one key differ', async () => {
    const key = await deriveWrappingKey(PRF)
    const a = await wrapWorkspaceKey(key, RESPONSE, BINDING)
    const b = await wrapWorkspaceKey(key, RESPONSE, BINDING)

    // A repeated iv under one AES-GCM key is the failure that leaks
    // plaintext, so it is asserted rather than assumed of the implementation.
    expect(a.iv).not.toEqual(b.iv)
    expect(a.ct).not.toEqual(b.ct)
  })

  it('parses as its own schema, since the store round-trips it through JSON', async () => {
    const blob = await wrapWorkspaceKey(await deriveWrappingKey(PRF), RESPONSE, BINDING)

    expect(wrappedWorkspaceKeySchema.parse(JSON.parse(JSON.stringify(blob)))).toEqual(blob)
  })
})

describe('unwrapWorkspaceKey', () => {
  it('refuses a blob wrapped for a different workspace', async () => {
    const key = await deriveWrappingKey(PRF)
    const blob = await wrapWorkspaceKey(key, RESPONSE, BINDING)

    // The binding is the AAD, so a blob copied between two workspaces on one
    // device opens nothing — one gesture yields one wrapping key for the
    // session, and that key alone must not be enough.
    expect(await unwrapWorkspaceKey(key, blob, { ...BINDING, workspaceId: 'ws-2' })).toBeNull()
    expect(
      await unwrapWorkspaceKey(key, blob, { ...BINDING, daemonBaseUrl: 'http://127.0.0.1:4000' }),
    ).toBeNull()
  })

  it('answers null rather than throwing on a corrupt blob', async () => {
    const key = await deriveWrappingKey(PRF)
    const blob = await wrapWorkspaceKey(key, RESPONSE, BINDING)

    // Fails CLOSED and in one piece: a reader gets "no key here", never a
    // half-parsed response, and never an exception it has to know about.
    expect(
      await unwrapWorkspaceKey(key, { ...blob, ct: 'not-base64url-at-all!!' }, BINDING),
    ).toBeNull()
    expect(await unwrapWorkspaceKey(key, { ...blob, iv: blob.ct }, BINDING)).toBeNull()
  })

  it('carries a bounded lease across the wrap, since the holder honours it', async () => {
    const key = await deriveWrappingKey(PRF)
    const bounded = {
      ...RESPONSE,
      tier: 'bounded' as const,
      leaseExpiresAt: '2027-01-01T00:00:00.000Z',
    }

    const reopened = await unwrapWorkspaceKey(
      key,
      await wrapWorkspaceKey(key, bounded, BINDING),
      BINDING,
    )

    // Unwrapping must not extend a lease: the expiry rides through unchanged
    // so the holder can lapse it exactly as it would after a fetch.
    expect(reopened).toEqual(bounded)
  })
})
