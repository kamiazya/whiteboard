/**
 * The browser half of ADR-0039: a passkey registered against the daemon a
 * person paired, and the assertion it produces when they promote.
 *
 * Nothing secret lives here (decision 1). What this module keeps is the
 * credential ID a daemon pinned, keyed by that daemon's base URL, so the
 * next promote can name it in `allowCredentials`. The key itself is the
 * authenticator's; the daemon holds the public half from `registerPasskey`
 * and verifies every assertion against that pin, never against anything
 * the browser sends later.
 *
 * The relying party is the page's own origin (WebAuthn's default `rp.id`),
 * which is what the daemon expects a pin for: it derives the rpId from the
 * Origin header the registration arrived under. Two origins therefore mean
 * two passkeys, as the ADR's consequences say.
 */
import {
  type Attestation,
  apiErrorReason,
  base64urlSchema,
  pinnedCredentialSummarySchema,
  promotionChallengeInput,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { z } from 'zod'
import { prfOutputOf } from './passkey-prf.js'
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

export type RegisteredPasskey = z.infer<typeof registeredPasskeySchema>

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The two WebAuthn calls this module makes — the shape a test double provides. */
export interface PasskeyCredentials {
  create(options: CredentialCreationOptions): Promise<Credential | null>
  get(options: CredentialRequestOptions): Promise<Credential | null>
}

const daemonKey = (daemonBaseUrl: string): string => daemonBaseUrl.replace(/\/+$/, '')

/**
 * ONE gesture (ADR-0042 d6 + ADR-0039 d6): the assertion that proves the
 * person is the assertion that yields the key material, rather than two
 * prompts for one intent. Absent an input the extension is not asked for at
 * all, so the promote attestation and the session bind keep making exactly
 * the call they always made.
 */
/**
 * Negotiated at CREATE: several authenticators decide there, rather than at
 * assertion time, whether a credential can ever produce a prf output — so a
 * passkey minted without this could never unwrap a replica and nothing would
 * say why.
 */
const PRF_AT_CREATE = { prf: {} }

function prfExtension(prfInput: Uint8Array | undefined) {
  if (prfInput === undefined) return {}
  return { extensions: { prf: { eval: { first: prfInput as BufferSource } } } }
}

function loadPasskeys(storage: StorageLike): Record<string, RegisteredPasskey> {
  // A record this build cannot read reads as no passkey for THAT daemon, and
  // the next registration writes a fresh one; the others stay.
  return readStoredRecord(storage.getItem(PASSKEYS_KEY), registeredPasskeySchema)
}

export function getRegisteredPasskey(
  daemonBaseUrl: string,
  storage: StorageLike = globalThis.localStorage,
): RegisteredPasskey | null {
  return loadPasskeys(storage)[daemonKey(daemonBaseUrl)] ?? null
}

/**
 * Forgets the passkey registered for this daemon.
 *
 * Its caller is the settings card that REVOKES a pin: without this, the
 * browser keeps naming a credential the daemon no longer holds, and the next
 * move is refused for a reason the person cannot act on — they revoked it
 * themselves, one screen earlier.
 */
export function forgetRegisteredPasskey(
  daemonBaseUrl: string,
  storage: StorageLike = globalThis.localStorage,
): void {
  const passkeys = loadPasskeys(storage)
  if (!(daemonKey(daemonBaseUrl) in passkeys)) return
  const { [daemonKey(daemonBaseUrl)]: _removed, ...rest } = passkeys
  storage.setItem(PASSKEYS_KEY, JSON.stringify(rest))
}

/** Whether this page can ask a passkey at all — a secure context with the WebAuthn API. */
export function passkeySupported(
  win: { PublicKeyCredential?: unknown; navigator?: { credentials?: unknown } } = globalThis,
): boolean {
  return win.PublicKeyCredential !== undefined && win.navigator?.credentials !== undefined
}

function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const isCancelled = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError')

export type RegisterPasskeyResult =
  | { ok: true; credentialId: string; backupEligible: boolean }
  | {
      ok: false
      reason: 'unsupported' | 'cancelled' | 'rejected' | 'unreachable'
      detail?: string
    }

/**
 * Creates a passkey for this origin and pins its public key on the daemon
 * (`POST /api/pairing/credentials`, which the paired origin's bearer and
 * the browser-enforced Origin header authorise). ES256 only, user
 * verification required — an authenticator that cannot verify the user is
 * refused here rather than at the promote it was meant for.
 */
export async function registerPasskey({
  daemonBaseUrl,
  fetch,
  credentials = globalThis.navigator?.credentials,
  storage = globalThis.localStorage,
  rpName = 'Whiteboard',
  userName = 'whiteboard',
}: {
  daemonBaseUrl: string
  /** A daemon fetch: the pairing bearer rides on it. */
  fetch: typeof globalThis.fetch
  credentials?: PasskeyCredentials
  storage?: StorageLike
  rpName?: string
  userName?: string
}): Promise<RegisterPasskeyResult> {
  if (credentials === undefined) return { ok: false, reason: 'unsupported' }
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const userId = crypto.getRandomValues(new Uint8Array(16))
  let credential: Credential | null
  try {
    credential = await credentials.create({
      publicKey: {
        rp: { name: rpName },
        user: { id: userId, name: userName, displayName: userName },
        challenge,
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        attestation: 'none',
        extensions: PRF_AT_CREATE,
      },
    })
  } catch (err) {
    if (isCancelled(err)) return { ok: false, reason: 'cancelled' }
    return { ok: false, reason: 'rejected', detail: String(err) }
  }
  if (credential === null) return { ok: false, reason: 'cancelled' }
  const response = (credential as PublicKeyCredential).response as AuthenticatorAttestationResponse
  // getPublicKey() is the SPKI the daemon parses without a CBOR decoder;
  // a browser without it cannot register through this daemon.
  if (typeof response.getPublicKey !== 'function') return { ok: false, reason: 'unsupported' }
  const publicKey = response.getPublicKey()
  if (publicKey === null) return { ok: false, reason: 'unsupported' }
  const credentialId = bytesToBase64Url((credential as PublicKeyCredential).rawId)

  let res: Response
  try {
    res = await fetch(`${daemonKey(daemonBaseUrl)}/api/pairing/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        credentialId,
        publicKey: bytesToBase64Url(publicKey),
        authenticatorData: bytesToBase64Url(response.getAuthenticatorData()),
      }),
    })
  } catch (err) {
    return { ok: false, reason: 'unreachable', detail: String(err) }
  }
  if (!res.ok) {
    let detail: string | undefined
    try {
      detail = apiErrorReason(await res.json())
    } catch {
      // A body that is not the contract leaves the status to speak.
    }
    return { ok: false, reason: 'rejected', detail: detail ?? `Request failed (${res.status}).` }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  const pinned = pinnedCredentialSummarySchema.safeParse(body)
  if (!pinned.success) return { ok: false, reason: 'rejected', detail: 'malformed response' }

  const passkeys = loadPasskeys(storage)
  storage.setItem(
    PASSKEYS_KEY,
    JSON.stringify({
      ...passkeys,
      [daemonKey(daemonBaseUrl)]: { credentialId, registeredAt: pinned.data.createdAt },
    }),
  )
  return { ok: true, credentialId, backupEligible: pinned.data.backupEligible }
}

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

export type AttestOutcome =
  | {
      ok: true
      attestation: Attestation
      /** The `prf` output this assertion carried, when one was asked for and
       *  the authenticator produced it. Absent is ORDINARY — the person was
       *  still verified, and only the cold-start key material is missing. */
      prfOutput?: Uint8Array<ArrayBuffer>
    }
  | { ok: false; reason: 'cancelled' | 'rejected'; detail?: string }

/**
 * Asks the passkey registered for this daemon to sign an arbitrary CHALLENGE
 * — shared by promotion (over the workspace+snapshot digest) and
 * `passkey-session.ts`'s session bind (over a daemon-minted nonce). Null
 * when no passkey is registered here, the same "absence means not asked"
 * reading `attestPromotion` documents below.
 */
export async function assertWithRegisteredPasskey({
  daemonBaseUrl,
  challenge,
  prfInput,
  credentials = globalThis.navigator?.credentials,
  storage = globalThis.localStorage,
}: {
  daemonBaseUrl: string
  challenge: Uint8Array
  /** Ask this assertion for a `prf` output too (`passkey-prf.ts`). */
  prfInput?: Uint8Array
  credentials?: PasskeyCredentials
  storage?: StorageLike
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
        ...prfExtension(prfInput),
      },
    })
  } catch (err) {
    if (isCancelled(err)) return { ok: false, reason: 'cancelled' }
    return { ok: false, reason: 'rejected', detail: String(err) }
  }
  if (credential === null) return { ok: false, reason: 'cancelled' }
  const pk = credential as PublicKeyCredential
  const response = pk.response as AuthenticatorAssertionResponse
  const prfOutput = prfInput === undefined ? null : prfOutputOf(pk)
  return {
    ok: true,
    attestation: {
      kind: 'webauthn',
      credentialId: bytesToBase64Url(pk.rawId),
      authenticatorData: bytesToBase64Url(response.authenticatorData),
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      signature: bytesToBase64Url(response.signature),
    },
    ...(prfOutput === null ? {} : { prfOutput }),
  }
}

/**
 * Asks the passkey registered for this daemon to sign THIS snapshot into
 * THIS workspace. Null when no passkey is registered here — the caller then
 * promotes without evidence and says so, which is the honest reading of a
 * browser that could not ask (decision 5: absence means not asked).
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
