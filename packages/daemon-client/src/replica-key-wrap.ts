/**
 * Persisting a workspace's read-plane key WRAPPED, so a replica survives the
 * tab closing (ADR-0042 decision 6) without the key ever sitting on disk.
 *
 * The wrapping key is derived from a passkey's WebAuthn `prf` output, which
 * the authenticator produces and nothing stores. What lands beside the
 * replica is ciphertext: useless to whatever later owns the origin, which is
 * the scenario `docs/explanation/security-model.md` records as the one only
 * encryption reaches.
 *
 * The cost of this, chosen knowingly (ADR-0035 named it, user decision
 * 2026-09-21): **the passkey provider becomes the recovery path.** Lose the
 * credential there and the local copy cannot be read again. That is a
 * sentence the UI owes the user, and it is declared once in
 * `apps/web`'s destructive-copy module rather than here.
 *
 * ## Why the binding is the AAD and not the HKDF info
 *
 * ONE gesture yields ONE prf output for the session — asking the
 * authenticator per workspace would be the second prompt this whole design
 * exists to avoid — so the wrapping key cannot carry a workspace in its
 * derivation. The (daemon, workspace) pair therefore rides as AES-GCM
 * additional data, which is checked on every open at no cost: a blob copied
 * between two workspaces on one device opens nothing, even though the same
 * key wrapped both.
 */
import { z } from 'zod'
import { replicaKeyResponseSchema } from './api-contracts/replica-key.js'

const textEncoder = new TextEncoder()

/** What WebAuthn's `prf` extension produces for one `eval` input. */
const PRF_OUTPUT_BYTES = 32
const WRAP_IV_BYTES = 12
const DERIVED_KEY_BITS = 256

/**
 * Base64url without padding, the encoding every other stored shape here uses
 * — the blob is JSON in a browser store, so the bytes have to be text.
 */
const BASE64URL = /^[A-Za-z0-9_-]+$/

export const wrappedWorkspaceKeySchema = z
  .object({
    v: z.literal(1),
    iv: z.string().regex(BASE64URL),
    ct: z.string().regex(BASE64URL),
  })
  .strict()

export type WrappedWorkspaceKey = z.infer<typeof wrappedWorkspaceKeySchema>

/** Which replica a wrapped blob belongs to. Checked on every open. */
export interface WrapBinding {
  daemonBaseUrl: string
  workspaceId: string
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/** The bytes AES-GCM checks but does not encrypt — see the header. */
function bindingBytes({ daemonBaseUrl, workspaceId }: WrapBinding): Uint8Array<ArrayBuffer> {
  // A JSON array rather than a joined string: a delimiter inside a value
  // cannot shift the boundary, which is the same reason `read-plane.ts`
  // builds its own context this way.
  return textEncoder.encode(JSON.stringify(['wb-replica-wrap-v1', daemonBaseUrl, workspaceId]))
}

/**
 * The wrapping key for this session, from one authenticator response.
 *
 * HKDF rather than importing the prf output directly: the output is the
 * authenticator's to shape, and a versioned `info` is what lets a later
 * version derive a different key from the same authenticator without
 * re-registering anything.
 */
export async function deriveWrappingKey(prfOutput: Uint8Array): Promise<CryptoKey> {
  if (prfOutput.length !== PRF_OUTPUT_BYTES) {
    throw new RangeError(`prf output must be ${PRF_OUTPUT_BYTES} bytes, got ${prfOutput.length}`)
  }
  const hkdfKey = await crypto.subtle.importKey('raw', prfOutput as BufferSource, 'HKDF', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // Empty salt: RFC 5869 permits it, and the prf output is already 32
      // uniform bytes from the authenticator rather than a password.
      salt: new Uint8Array(0),
      info: textEncoder.encode('wb-replica-wrap-v1'),
    },
    hkdfKey,
    DERIVED_KEY_BITS,
  )
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/**
 * Wraps the whole replica-key RESPONSE rather than the key bytes alone, so a
 * cold start rebuilds the holder's state through the same parse a fetch goes
 * through — tier and lease included. One schema, one shape, no second
 * hand-written copy of what a response is.
 */
export async function wrapWorkspaceKey(
  wrappingKey: CryptoKey,
  response: z.infer<typeof replicaKeyResponseSchema>,
  binding: WrapBinding,
): Promise<WrappedWorkspaceKey> {
  const iv = crypto.getRandomValues(new Uint8Array(WRAP_IV_BYTES))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: bindingBytes(binding) },
    wrappingKey,
    textEncoder.encode(JSON.stringify(response)) as BufferSource,
  )
  return { v: 1, iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) }
}

/**
 * Opens a wrapped blob, or answers null.
 *
 * Null for EVERY failure — a wrong authenticator, a blob belonging to
 * another workspace, corrupt text, a payload that no longer parses as a
 * response — because a caller can do exactly one thing about any of them
 * (ask the daemon again) and a partial answer would be worse than none.
 */
export async function unwrapWorkspaceKey(
  wrappingKey: CryptoKey,
  blob: WrappedWorkspaceKey,
  binding: WrapBinding,
): Promise<z.infer<typeof replicaKeyResponseSchema> | null> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(blob.iv) as BufferSource,
        additionalData: bindingBytes(binding),
      },
      wrappingKey,
      fromBase64Url(blob.ct) as BufferSource,
    )
    const parsed = replicaKeyResponseSchema.safeParse(
      JSON.parse(new TextDecoder().decode(plaintext)),
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
