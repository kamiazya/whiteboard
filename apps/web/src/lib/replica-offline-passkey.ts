/**
 * A passkey that exists only to make one cached copy readable offline
 * (ADR-0050 decision 11, over ADR-0042 decision 6's wrap).
 *
 * It is created in THIS browser and is never shown to a daemon: nothing here
 * sends a request, and nothing is registered anywhere. Its only job is the
 * WebAuthn `prf` output, which wraps the copy's key and which an
 * authenticator produces only after verifying the person. That is what
 * ADR-0050 decision 8 keeps once the passkey stops being a way to sign in to
 * a local daemon.
 *
 * One credential per copy, with a random salt. The salt is not a secret — the
 * authenticator's own key is — so it sits beside the credential id in
 * localStorage, next to the wrapped blob it opens (`replica-wrapped-key-store.ts`
 * gives the reasons for localStorage over IndexedDB, and they hold here too).
 * A record that does not parse reads as absent, the same posture that store
 * takes.
 */
import {
  BASE64URL,
  fromBase64Url,
  toBase64Url,
} from '@kamiazya/whiteboard-daemon-client/replica-key-wrap'
import { z } from 'zod'
import { prfOutputOf } from './passkey-prf.js'
import { readStoredRecord } from './stored-record.js'

const STORE_KEY = 'whiteboard:replica-offline-passkeys'
const SALT_BYTES = 32

const offlinePasskeySchema = z
  .object({
    credentialId: z.string().regex(BASE64URL),
    prfSalt: z.string().regex(BASE64URL),
  })
  .strict()

export type OfflinePasskey = z.infer<typeof offlinePasskeySchema>

/** The two WebAuthn calls this module makes — what a test double provides. */
export type OfflinePasskeyCredentials = Pick<CredentialsContainer, 'create' | 'get'>

/** The same (daemon, workspace) key `replica-wrapped-key-store.ts` uses, so the two records pair up. */
const entryKey = (daemonBaseUrl: string, workspaceId: string): string =>
  `${daemonBaseUrl.replace(/\/+$/, '')}\u0000${workspaceId}`

function load(): Record<string, OfflinePasskey> {
  try {
    return readStoredRecord(localStorage.getItem(STORE_KEY), offlinePasskeySchema)
  } catch {
    return {}
  }
}

function save(records: Record<string, OfflinePasskey>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(records))
  } catch {
    // A browser refusing storage keeps nothing, which the caller reads back
    // as "not readable offline" — the truth.
  }
}

export function loadOfflinePasskey(
  daemonBaseUrl: string,
  workspaceId: string,
): OfflinePasskey | null {
  return load()[entryKey(daemonBaseUrl, workspaceId)] ?? null
}

export function saveOfflinePasskey(
  daemonBaseUrl: string,
  workspaceId: string,
  record: OfflinePasskey,
): void {
  save({ ...load(), [entryKey(daemonBaseUrl, workspaceId)]: record })
}

export function dropOfflinePasskey(daemonBaseUrl: string, workspaceId: string): void {
  const { [entryKey(daemonBaseUrl, workspaceId)]: _dropped, ...rest } = load()
  save(rest)
}

/** The WebAuthn API as this page sees it, or undefined where there is none. */
export function browserCredentials(): OfflinePasskeyCredentials | undefined {
  return globalThis.PublicKeyCredential === undefined
    ? undefined
    : globalThis.navigator?.credentials
}

const isCancelled = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError')

const prfAsking = (salt: Uint8Array) => ({ prf: { eval: { first: salt as BufferSource } } })

export type AssertOutcome =
  | { ok: true; prfOutput: Uint8Array<ArrayBuffer> }
  | { ok: false; reason: 'no-passkey' | 'cancelled' | 'no-prf' }

/** One verified assertion with the copy's own credential, for its `prf` output. */
export async function assertOfflinePasskey(
  record: OfflinePasskey,
  credentials: OfflinePasskeyCredentials | undefined = browserCredentials(),
): Promise<AssertOutcome> {
  if (credentials === undefined) return { ok: false, reason: 'no-passkey' }
  let credential: Credential | null
  try {
    credential = await credentials.get({
      publicKey: {
        // Local and random: nothing verifies this signature. What protects
        // the copy is the AES-GCM open, which a wrong person fails.
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [
          { type: 'public-key', id: fromBase64Url(record.credentialId) as BufferSource },
        ],
        userVerification: 'required',
        extensions: prfAsking(fromBase64Url(record.prfSalt)),
      },
    })
  } catch {
    return { ok: false, reason: 'cancelled' }
  }
  if (credential === null) return { ok: false, reason: 'cancelled' }
  const prfOutput = prfOutputOf(credential as PublicKeyCredential)
  return prfOutput === null ? { ok: false, reason: 'no-prf' } : { ok: true, prfOutput }
}

export type CreateOutcome =
  | { ok: true; record: OfflinePasskey; prfOutput: Uint8Array<ArrayBuffer> }
  | { ok: false; reason: 'unsupported' | 'cancelled' }

/**
 * Probed from the browser rather than assumed: `getClientCapabilities` says
 * whether the extension exists at all, before a passkey is created that could
 * never lock anything. Absent the probe, the authenticator's own answer at
 * creation decides.
 */
async function browserLacksPrf(): Promise<boolean> {
  const probe = (
    globalThis.PublicKeyCredential as
      | { getClientCapabilities?: () => Promise<Record<string, boolean>> }
      | undefined
  )?.getClientCapabilities
  if (probe === undefined) return false
  try {
    return (await probe())['extension:prf'] === false
  } catch {
    return false
  }
}

/** User verification required: the gesture is what stands between the copy and whoever holds the device. */
function creationOptions(label: string, salt: Uint8Array): CredentialCreationOptions {
  return {
    publicKey: {
      rp: { name: 'Whiteboard' },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: `${label} (offline copy)`,
        displayName: `${label} (offline copy)`,
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      attestation: 'none',
      extensions: prfAsking(salt),
    },
  }
}

/**
 * Creates the copy's passkey and answers its first `prf` output.
 *
 * Two authenticator shapes ship: one evaluates `prf` at creation, another only
 * enables it there and evaluates on assertion. The second costs a second
 * gesture, once, at an action the person just chose — never at an unlock.
 */
export async function createOfflinePasskey({
  label,
  credentials = browserCredentials(),
}: {
  /** What the person will see in their passkey manager. */
  label: string
  credentials?: OfflinePasskeyCredentials
}): Promise<CreateOutcome> {
  if (credentials === undefined || (await browserLacksPrf())) {
    return { ok: false, reason: 'unsupported' }
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  let credential: Credential | null
  try {
    credential = await credentials.create(creationOptions(label, salt))
  } catch (err) {
    return { ok: false, reason: isCancelled(err) ? 'cancelled' : 'unsupported' }
  }
  if (credential === null) return { ok: false, reason: 'cancelled' }
  const created = credential as PublicKeyCredential
  const record = {
    credentialId: toBase64Url(new Uint8Array(created.rawId)),
    prfSalt: toBase64Url(salt),
  }
  const atCreate = prfOutputOf(created)
  if (atCreate !== null) return { ok: true, record, prfOutput: atCreate }
  const enabled = (
    created.getClientExtensionResults?.() as { prf?: { enabled?: boolean } } | undefined
  )?.prf?.enabled
  if (enabled !== true) return { ok: false, reason: 'unsupported' }
  const asserted = await assertOfflinePasskey(record, credentials)
  if (asserted.ok) return { ok: true, record, prfOutput: asserted.prfOutput }
  return { ok: false, reason: asserted.reason === 'cancelled' ? 'cancelled' : 'unsupported' }
}
