/**
 * The browser half of ADR-0039 as the transfer receiver still uses it: the
 * assertion a passkey registered for a keeper's origin produces when a
 * workspace is accepted there (`accept-transferred-record.ts`).
 *
 * Nothing secret lives here (decision 1). What this module reads is the
 * credential ID a keeper pinned, keyed by that keeper's base URL, so the
 * assertion can name it in `allowCredentials`. The key itself is the
 * authenticator's; the keeper holds the public half and verifies every
 * assertion against that pin.
 *
 * Registration is gone with the local daemon's pairing (ADR-0050 decision
 * 3): the local daemon has one person and nothing for a passkey to tell
 * apart, and a keeper at its own origin registers its own.
 */
import {
  type Attestation,
  base64urlSchema,
  promotionChallengeInput,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { z } from 'zod'
import { readStoredRecord } from './stored-record.js'

const PASSKEYS_KEY = 'whiteboard:daemon-passkeys'

const registeredPasskeySchema = z
  .object({
    // Validated at the storage boundary so a record that cannot be decoded
    // reads as no passkey, the same as any other corrupt record — rather
    // than throwing on the way into `allowCredentials` and failing the move.
    credentialId: base64urlSchema,
    registeredAt: z.string(),
  })
  .strict()

type RegisteredPasskey = z.infer<typeof registeredPasskeySchema>

interface StorageLike {
  getItem(key: string): string | null
}

/** The WebAuthn calls a test double provides. */
export interface PasskeyCredentials {
  create(options: CredentialCreationOptions): Promise<Credential | null>
  get(options: CredentialRequestOptions): Promise<Credential | null>
}

const daemonKey = (daemonBaseUrl: string): string => daemonBaseUrl.replace(/\/+$/, '')

function loadPasskeys(storage: StorageLike): Record<string, RegisteredPasskey> {
  // A record this build cannot read reads as no passkey for THAT keeper; the
  // others stay.
  return readStoredRecord(storage.getItem(PASSKEYS_KEY), registeredPasskeySchema)
}

function getRegisteredPasskey(
  daemonBaseUrl: string,
  storage: StorageLike,
): RegisteredPasskey | null {
  return loadPasskeys(storage)[daemonKey(daemonBaseUrl)] ?? null
}

function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const isCancelled = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError')

/** The bytes a promotion's assertion is signed over: what the daemon recomputes from the same inputs. */
export async function promotionChallenge(
  workspaceId: string,
  snapshot: Uint8Array,
): Promise<Uint8Array> {
  const snapshotDigest = bytesToBase64Url(
    await crypto.subtle.digest('SHA-256', snapshot as BufferSource),
  )
  return new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      promotionChallengeInput({ workspaceId, snapshotDigest }) as BufferSource,
    ),
  )
}

type AttestOutcome =
  | { ok: true; attestation: Attestation }
  | { ok: false; reason: 'cancelled' | 'rejected'; detail?: string }

/** Asks the passkey registered for this keeper to sign CHALLENGE; null when none is registered here. */
async function assertWithRegisteredPasskey({
  daemonBaseUrl,
  challenge,
  credentials,
  storage,
}: {
  daemonBaseUrl: string
  challenge: Uint8Array
  credentials: PasskeyCredentials | undefined
  storage: StorageLike
}): Promise<AttestOutcome | null> {
  const registered = getRegisteredPasskey(daemonBaseUrl, storage)
  if (registered === null || credentials === undefined) return null
  let credential: Credential | null
  try {
    credential = await credentials.get({
      publicKey: {
        challenge: challenge as BufferSource,
        allowCredentials: [
          { type: 'public-key', id: base64UrlToBytes(registered.credentialId) as BufferSource },
        ],
        userVerification: 'required',
      },
    })
  } catch (err) {
    if (isCancelled(err)) return { ok: false, reason: 'cancelled' }
    return { ok: false, reason: 'rejected', detail: String(err) }
  }
  if (credential === null) return { ok: false, reason: 'cancelled' }
  const pk = credential as PublicKeyCredential
  const response = pk.response as AuthenticatorAssertionResponse
  return {
    ok: true,
    attestation: {
      kind: 'webauthn',
      credentialId: bytesToBase64Url(pk.rawId),
      authenticatorData: bytesToBase64Url(response.authenticatorData),
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      signature: bytesToBase64Url(response.signature),
    },
  }
}

/**
 * Asks the passkey registered for this keeper to sign THIS snapshot into
 * THIS workspace. Null when no passkey is registered here, which the
 * receiver refuses (ADR-0039's 2026-09-22 addendum).
 */
export async function attestPromotion({
  daemonBaseUrl,
  workspaceId,
  snapshot,
  credentials = globalThis.navigator?.credentials,
  storage = globalThis.localStorage,
}: {
  daemonBaseUrl: string
  /** The handle as the promote URL will address it — what the daemon hashes. */
  workspaceId: string
  snapshot: Uint8Array
  credentials?: PasskeyCredentials
  storage?: StorageLike
}): Promise<AttestOutcome | null> {
  const challenge = await promotionChallenge(workspaceId, snapshot)
  return assertWithRegisteredPasskey({ daemonBaseUrl, challenge, credentials, storage })
}
