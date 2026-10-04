/**
 * Opening a remembered replica from disk (ADR-0042 decision 6).
 *
 * Between them, the two functions here are the whole cold start. The write
 * half runs when Settings makes a copy readable offline, wrapping the key
 * under the prf output of the passkey it just created in this browser; the
 * read half runs on a later tab with the daemon unreachable, and turns one
 * gesture of that passkey into a held key.
 *
 * What never happens here is a second prompt. `rememberReplicaKey` takes a
 * prf output the caller already has rather than asking for one, and
 * `unlockReplicaKey` asks only when there is something to open and it is not
 * open already — a gesture that cannot change the outcome teaches a person
 * that the gesture means nothing.
 *
 * ## The challenge is local, and that is not a weakness
 *
 * An unlock happens with the daemon unreachable, so nothing can mint a
 * challenge and nothing verifies the signature. The assertion is not being
 * used as proof to a server: it is being used to make the authenticator
 * produce a prf output, which it does only after verifying the person. The
 * security of the unlock rests on the AES-GCM open, which no challenge could
 * help with — a wrong person simply derives a different key and gets
 * nothing. The challenge is random anyway, because a constant one would be
 * a signature a caller could replay somewhere that DOES verify.
 */

import {
  type ReplicaKeyResponse,
  type ReplicaTier,
  replicaKeyResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import {
  deriveWrappingKey,
  unwrapWorkspaceKey,
  wrapWorkspaceKey,
} from '@kamiazya/whiteboard-daemon-client/replica-key-wrap'
import {
  adoptSessionKey,
  sessionKeyStatus,
} from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import {
  assertOfflinePasskey,
  browserCredentials,
  createOfflinePasskey,
  dropOfflinePasskey,
  loadOfflinePasskey,
  type OfflinePasskeyCredentials,
  saveOfflinePasskey,
} from './replica-offline-passkey.js'
import { dropWrappedKey, loadWrappedKey, saveWrappedKey } from './replica-wrapped-key-store.js'

/**
 * Why an unlock did not happen. Each arm is a different sentence to a
 * person, which is the only reason they are distinguished:
 *
 * - `no-blob` — nothing was remembered for this replica. Connect once.
 * - `no-passkey` — this browser offers no WebAuthn to ask.
 * - `no-prf` — the authenticator verified the person and produced no key
 *   material. Another browser on this machine may still open it.
 * - `cancelled` — the person dismissed the prompt. Offer it again.
 * - `unopenable` — nothing on this device can read what was remembered,
 *   including a copy no passkey in this browser was kept for.
 * - `lapsed` — the bounded lease it was remembered under has been spent.
 */
type UnlockFailure = 'no-blob' | 'no-passkey' | 'no-prf' | 'cancelled' | 'unopenable' | 'lapsed'

export type UnlockOutcome = { ok: true; tier: ReplicaTier } | { ok: false; reason: UnlockFailure }

/**
 * Wraps a freshly minted replica key and leaves it beside the replica.
 *
 * Takes the prf output rather than asking for one: the caller just performed
 * the gesture, and asking again here would be the second prompt this design
 * exists to avoid.
 */
export async function rememberReplicaKey({
  daemonBaseUrl,
  workspaceId,
  response,
  prfOutput,
}: {
  daemonBaseUrl: string
  workspaceId: string
  response: ReplicaKeyResponse
  prfOutput: Uint8Array
}): Promise<void> {
  const wrappingKey = await deriveWrappingKey(prfOutput)
  const blob = await wrapWorkspaceKey(wrappingKey, response, { daemonBaseUrl, workspaceId })
  saveWrappedKey(daemonBaseUrl, workspaceId, blob)
}

/**
 * Turns one passkey gesture into a held key for a replica this device
 * remembered, with no daemon in reach.
 *
 * The two failures that can never resolve on their own take the blob with
 * them. Ciphertext nothing here can read is debris, and keeping it would
 * keep offering an unlock that cannot succeed; a spent lease is worse still,
 * since adopting it would hold bytes every read then rejects.
 */
export async function unlockReplicaKey({
  daemonBaseUrl,
  workspaceId,
  credentials = browserCredentials(),
}: {
  daemonBaseUrl: string
  workspaceId: string
  credentials?: OfflinePasskeyCredentials
}): Promise<UnlockOutcome> {
  const held = sessionKeyStatus(daemonBaseUrl, workspaceId)
  if (held?.kind === 'held') return { ok: true, tier: held.tier }

  const blob = loadWrappedKey(daemonBaseUrl, workspaceId)
  if (blob === null) return { ok: false, reason: 'no-blob' }

  const local = loadOfflinePasskey(daemonBaseUrl, workspaceId)
  if (local === null) {
    stopReplicaReadableOffline(daemonBaseUrl, workspaceId)
    return { ok: false, reason: 'unopenable' }
  }
  const prf = await assertOfflinePasskey(local, credentials)
  if (!prf.ok) return prf

  const wrappingKey = await deriveWrappingKey(prf.prfOutput)
  const response = await unwrapWorkspaceKey(wrappingKey, blob, { daemonBaseUrl, workspaceId })
  if (response === null) {
    stopReplicaReadableOffline(daemonBaseUrl, workspaceId)
    return { ok: false, reason: 'unopenable' }
  }

  if (!adoptSessionKey(daemonBaseUrl, workspaceId, response)) {
    stopReplicaReadableOffline(daemonBaseUrl, workspaceId)
    return { ok: false, reason: 'lapsed' }
  }
  return { ok: true, tier: response.tier }
}

/** True when this copy was made readable offline and can still be opened that way. */
export function isReplicaReadableOffline(daemonBaseUrl: string, workspaceId: string): boolean {
  return (
    loadOfflinePasskey(daemonBaseUrl, workspaceId) !== null &&
    loadWrappedKey(daemonBaseUrl, workspaceId) !== null
  )
}

/**
 * Why a copy could not be made readable offline. Each is its own sentence:
 * `unsupported` is this browser, `unreachable` is the daemon, `cancelled` is
 * the person, `no-offline` is the keeper's policy (ADR-0042 decision 5).
 */
export type OfflineOptInFailure = 'unsupported' | 'unreachable' | 'cancelled' | 'no-offline'

/**
 * Settings' "make readable offline" (ADR-0050 decision 11): creates a passkey
 * in this browser only and wraps the copy's key under its `prf` output.
 *
 * The key is asked for FIRST, because it has to be held to be wrapped — and a
 * passkey created before learning the daemon cannot hand it over would be one
 * the person has to find and delete for nothing.
 */
export async function makeReplicaReadableOffline({
  daemonBaseUrl,
  workspaceId,
  label,
  fetch,
  credentials = browserCredentials(),
}: {
  daemonBaseUrl: string
  workspaceId: string
  label: string
  /** A fetch that reaches this copy's daemon. */
  fetch: typeof globalThis.fetch
  credentials?: OfflinePasskeyCredentials
}): Promise<{ ok: true } | { ok: false; reason: OfflineOptInFailure }> {
  if (credentials === undefined) return { ok: false, reason: 'unsupported' }
  const response = await fetchReplicaKey(fetch, daemonBaseUrl, workspaceId)
  if (response === null) return { ok: false, reason: 'unreachable' }
  if (response.tier === 'no-offline') return { ok: false, reason: 'no-offline' }

  const created = await createOfflinePasskey({ label, credentials })
  if (!created.ok) return created
  await rememberReplicaKey({ daemonBaseUrl, workspaceId, response, prfOutput: created.prfOutput })
  saveOfflinePasskey(daemonBaseUrl, workspaceId, created.record)
  return { ok: true }
}

/**
 * Turning it off drops the wrapped key, which is what makes the copy
 * unopenable offline, and the credential record with it. The passkey itself
 * stays in the person's passkey manager: a page cannot delete one there.
 */
export function stopReplicaReadableOffline(daemonBaseUrl: string, workspaceId: string): void {
  dropWrappedKey(daemonBaseUrl, workspaceId)
  dropOfflinePasskey(daemonBaseUrl, workspaceId)
}

/** The request the session-key holder makes, answered as the parsed response or null. */
async function fetchReplicaKey(
  fetch: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
): Promise<ReplicaKeyResponse | null> {
  try {
    const res = await fetch(
      `${daemonBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/replica-key`,
      { method: 'POST' },
    )
    if (!res.ok) return null
    const parsed = replicaKeyResponseSchema.safeParse(await res.json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
