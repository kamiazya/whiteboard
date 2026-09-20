/**
 * The replica read page's five degradation states (ADR-0042 decisions 3-5).
 * A pure function so the whole (renewal x key) input space can be
 * enumerated and pinned by an exhaustive test — see
 * `replica-page-state.test.ts`.
 *
 * Deliberately takes neither the workspace's tier nor whether a registry
 * entry exists: the registry stores no tier at all (a daemon-kept
 * workspace's tier is fetched live, never persisted), a `bounded` lease
 * past its own expiry already answers `key: { withheld: 'lapsed' }`, and
 * `ReplicaReadPage` is only ever mounted once a registry entry is known to
 * exist — an absent entry is a `no-offline`-tier sentence the caller
 * states directly, never a fifth state this function has to invent.
 */
import type { WithheldReason } from '@kamiazya/whiteboard-daemon-client/replica-session-key'

/** What `renewPairingToken` answered, collapsed to the two outcomes this page distinguishes. */
export type ReplicaRenewalInput = 'unreachable' | 'refused'

/** What the S4a holder knows about this workspace's key, at the moment the page asks. */
export type ReplicaKeyInput = 'readable' | 'missing' | { withheld: WithheldReason }

export const REPLICA_PAGE_STATES = [
  'needs-connection',
  'readable',
  'locked',
  'unpaired',
  'removed',
] as const
export type ReplicaPageState = (typeof REPLICA_PAGE_STATES)[number]

/**
 * A membership refusal the daemon itself returned — the key request
 * REACHED the daemon and it said no. Nothing here will ever be sent,
 * which is exactly what the 'removed' state promises. The other four
 * `WithheldReason` values (`unreachable`, `lapsed`, `unknown_credential`,
 * `requires_person_session`) all describe a condition that reconnecting
 * can fix, so they land on 'locked' instead.
 */
const REMOVAL_REASONS = new Set<WithheldReason>([
  'not_a_member',
  'unknown_profile',
  'replica_not_allowed',
  'unknown_workspace',
  'invalid_workspace_id',
])

export function replicaPageState({
  renewal,
  key,
}: {
  renewal: ReplicaRenewalInput
  key: ReplicaKeyInput
}): ReplicaPageState {
  // A refused renewal is a daemon decision, checked first and unconditionally:
  // a key still held readable in memory from an earlier session must not go
  // on rendering content for a workspace the daemon just refused to renew.
  // It is NOT 'removed', though: the token route answers the same 403 for a
  // revoked grant and for a daemon whose grant store was lost, and neither
  // says anything about the person's MEMBERSHIP. Only the replica-key route
  // can say that (below). What a refused renewal does establish is that this
  // device is no longer paired, which is exactly what it is told.
  if (renewal === 'refused') return 'unpaired'
  if (key === 'missing') return 'needs-connection'
  if (key === 'readable') return 'readable'
  return REMOVAL_REASONS.has(key.withheld) ? 'removed' : 'locked'
}
