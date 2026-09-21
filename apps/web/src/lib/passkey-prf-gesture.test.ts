/**
 * The ONE gesture (ADR-0042 d6 + ADR-0039 d6): the assertion that verifies
 * the person is the assertion that yields the key material.
 *
 * What these cases hold is that asking is OPT-IN and that not getting an
 * answer is ordinary. A caller with no `prfInput` makes exactly the call it
 * always made — no extension on the wire — and an authenticator that ignores
 * the extension still produces a verified person, just no key.
 */

import { describe, expect, it } from 'vitest'
import type { PasskeyCredentials } from './passkey-attestation.js'
import { assertWithRegisteredPasskey, registerPasskey } from './passkey-attestation.js'

const DAEMON = 'http://127.0.0.1:3099'
const RAW_ID = new Uint8Array([1, 2, 3, 4]).buffer

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  }
}

/** A storage that already holds a registered passkey for DAEMON. */
function registered(): Storage {
  const storage = memoryStorage()
  storage.setItem(
    'whiteboard:daemon-passkeys',
    // `registeredPasskeySchema` is `.strict()` and requires `registeredAt`;
    // a record it cannot parse reads as NO passkey, and the assert then
    // answers null without ever prompting.
    JSON.stringify({ [DAEMON]: { credentialId: 'AQIDBA', registeredAt: '2026-09-21T00:00:00Z' } }),
  )
  return storage
}

function assertionCredential(prf?: ArrayBuffer): PublicKeyCredential {
  return {
    rawId: RAW_ID,
    response: {
      authenticatorData: new Uint8Array([9]).buffer,
      clientDataJSON: new Uint8Array([8]).buffer,
      signature: new Uint8Array([7]).buffer,
    },
    getClientExtensionResults: () =>
      (prf === undefined ? {} : { prf: { results: { first: prf } } }) as never,
  } as unknown as PublicKeyCredential
}

function capturing(credential: PublicKeyCredential): {
  credentials: PasskeyCredentials
  asked: () => CredentialRequestOptions[]
} {
  const calls: CredentialRequestOptions[] = []
  return {
    credentials: {
      create: async () => null,
      get: async (options) => {
        calls.push(options as CredentialRequestOptions)
        return credential
      },
    },
    asked: () => calls,
  }
}

describe('assertWithRegisteredPasskey', () => {
  it('asks for no extension at all when the caller wants no key material', async () => {
    const { credentials, asked } = capturing(assertionCredential())

    const outcome = await assertWithRegisteredPasskey({
      daemonBaseUrl: DAEMON,
      challenge: new Uint8Array([1]),
      credentials,
      storage: registered(),
    })

    // The promote attestation and the session bind both call this and want
    // no key: their prompt must stay byte-for-byte the call it always was.
    expect(asked()[0]?.publicKey?.extensions).toBeUndefined()
    expect(outcome?.ok).toBe(true)
    expect(outcome?.ok === true && outcome.prfOutput).toBeUndefined()
  })

  it('carries the prf input on the same assertion, and answers with its output', async () => {
    const first = new Uint8Array(32).fill(5)
    const { credentials, asked } = capturing(assertionCredential(first.buffer))

    const outcome = await assertWithRegisteredPasskey({
      daemonBaseUrl: DAEMON,
      challenge: new Uint8Array([1]),
      prfInput: new Uint8Array(32).fill(2),
      credentials,
      storage: registered(),
    })

    // ONE call, carrying both purposes — not two prompts.
    expect(asked()).toHaveLength(1)
    expect(asked()[0]?.publicKey?.userVerification).toBe('required')
    expect(outcome?.ok === true && outcome.prfOutput).toEqual(first)
  })

  it('still verifies the person when the authenticator ignores the extension', async () => {
    const { credentials } = capturing(assertionCredential())

    const outcome = await assertWithRegisteredPasskey({
      daemonBaseUrl: DAEMON,
      challenge: new Uint8Array([1]),
      prfInput: new Uint8Array(32).fill(2),
      credentials,
      storage: registered(),
    })

    // Broad support is not universal (ADR-0039's 2026-09-13 measurement), and
    // the degradation is silent by design: the attestation is whole, so the
    // bind and the promote still work, and only cold-start offline is absent.
    expect(outcome?.ok === true && outcome.attestation.kind).toBe('webauthn')
    expect(outcome?.ok === true && outcome.prfOutput).toBeUndefined()
  })
})

describe('registerPasskey', () => {
  it('negotiates prf when the credential is minted', async () => {
    const created: CredentialCreationOptions[] = []

    await registerPasskey({
      daemonBaseUrl: DAEMON,
      fetch: async () => new Response('{}', { status: 500 }),
      credentials: {
        create: async (options) => {
          created.push(options as CredentialCreationOptions)
          return null
        },
        get: async () => null,
      },
      storage: memoryStorage(),
    })

    // Several authenticators decide at CREATE whether a credential can ever
    // produce a prf output. Asking only at assertion time would leave a new
    // passkey permanently unable to unwrap a replica, with nothing saying so.
    expect(created[0]?.publicKey?.extensions).toEqual({ prf: {} })
  })
})
