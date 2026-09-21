/**
 * Opening a remembered replica from disk (ADR-0042 decision 6).
 *
 * Between them, the two functions here are the whole cold start. The write
 * half runs on the session that MINTED a key, wrapping it under the material
 * the passkey gesture already produced; the read half runs on a later tab
 * with the daemon unreachable, and turns one gesture into a held key.
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

import type { ReplicaTier } from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import {
  deriveWrappingKey,
  unwrapWorkspaceKey,
  wrapWorkspaceKey,
} from '@kamiazya/whiteboard-daemon-client/replica-key-wrap'
import type { ReplicaKeyResponse } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import {
  adoptSessionKey,
  sessionKeyStatus,
} from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import {
  assertWithRegisteredPasskey,
  type PasskeyCredentials,
  type StorageLike,
} from './passkey-attestation.js'
import { prfInputForDaemon } from './passkey-prf.js'
import { dropWrappedKey, loadWrappedKey, saveWrappedKey } from './replica-wrapped-key-store.js'

/**
 * Why an unlock did not happen. Each arm is a different sentence to a
 * person, which is the only reason they are distinguished:
 *
 * - `no-blob` — nothing was remembered for this replica. Connect once.
 * - `no-passkey` — this daemon has no registered passkey on this device.
 * - `no-prf` — the authenticator verified the person and produced no key
 *   material. Another browser on this machine may still open it.
 * - `cancelled` — the person dismissed the prompt. Offer it again.
 * - `unopenable` — nothing on this device can read what was remembered.
 * - `lapsed` — the bounded lease it was remembered under has been spent.
 */
export type UnlockFailure =
  | 'no-blob'
  | 'no-passkey'
  | 'no-prf'
  | 'cancelled'
  | 'unopenable'
  | 'lapsed'

export type UnlockOutcome = { ok: true; tier: ReplicaTier } | { ok: false; reason: UnlockFailure }

/** True when this replica has something an unlock could open — what decides whether the offer is shown at all. */
export function hasRememberedReplicaKey(daemonBaseUrl: string, workspaceId: string): boolean {
  return loadWrappedKey(daemonBaseUrl, workspaceId) !== null
}

/**
 * Wraps a freshly minted replica key and leaves it beside the replica.
 *
 * Takes the prf output rather than asking for one: the only caller is the
 * session that just performed the gesture, and asking again here would be
 * the second prompt this design exists to avoid.
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
  credentials,
  storage,
}: {
  daemonBaseUrl: string
  workspaceId: string
  credentials?: PasskeyCredentials
  storage?: StorageLike
}): Promise<UnlockOutcome> {
  const held = sessionKeyStatus(daemonBaseUrl, workspaceId)
  if (held?.kind === 'held') return { ok: true, tier: held.tier }

  const blob = loadWrappedKey(daemonBaseUrl, workspaceId)
  if (blob === null) return { ok: false, reason: 'no-blob' }

  const outcome = await assertWithRegisteredPasskey({
    daemonBaseUrl,
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    prfInput: await prfInputForDaemon(daemonBaseUrl),
    ...(credentials === undefined ? {} : { credentials }),
    ...(storage === undefined ? {} : { storage }),
  })
  if (outcome === null) return { ok: false, reason: 'no-passkey' }
  if (!outcome.ok) return { ok: false, reason: 'cancelled' }
  if (outcome.prfOutput === undefined) return { ok: false, reason: 'no-prf' }

  const wrappingKey = await deriveWrappingKey(outcome.prfOutput)
  const response = await unwrapWorkspaceKey(wrappingKey, blob, { daemonBaseUrl, workspaceId })
  if (response === null) {
    dropWrappedKey(daemonBaseUrl, workspaceId)
    return { ok: false, reason: 'unopenable' }
  }

  if (!adoptSessionKey(daemonBaseUrl, workspaceId, response)) {
    dropWrappedKey(daemonBaseUrl, workspaceId)
    return { ok: false, reason: 'lapsed' }
  }
  return { ok: true, tier: response.tier }
}
