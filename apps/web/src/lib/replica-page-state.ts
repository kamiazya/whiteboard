/**
 * The replica read page's five degradation states (ADR-0042 decisions 3-6).
 * A pure function so the whole (key x remembered) input space can
 * be enumerated and pinned by an exhaustive test — see
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

/** What the session-key holder knows about this workspace's key, at the moment the page asks. */
export type ReplicaKeyInput = 'readable' | 'missing' | { withheld: WithheldReason }

export const REPLICA_PAGE_STATES = [
  'needs-connection',
  'readable',
  'locked',
  'unlockable',
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
  key,
  remembered,
}: {
  key: ReplicaKeyInput
  /**
   * Whether this device holds a wrapped key for this workspace
   * (`replica-unlock.ts`'s `isReplicaReadableOffline`). It only ever
   * REFINES a state the daemon has not decided — see below.
   */
  remembered: boolean
}): ReplicaPageState {
  // Before `remembered` is consulted at all: a key already held needs no
  // gesture, and asking someone to prove themselves for something already
  // open is the prompt this whole design exists to avoid.
  if (key === 'readable') return 'readable'
  // Nothing asked yet. With a blob on disk that is the cold start itself,
  // so the offer is an unlock rather than "connect the daemon" — the
  // daemon may well be unreachable, and a remembered replica does not
  // need it.
  if (key === 'missing') return remembered ? 'unlockable' : 'needs-connection'
  // A membership refusal is the daemon REACHING this device and saying no
  // (ADR-0042 decision 3), which is exactly when a revocation takes
  // effect. Offering an unlock past it would make a local copy outrank the
  // decision that revoked it, so `remembered` never reaches this arm.
  if (REMOVAL_REASONS.has(key.withheld)) return 'removed'
  return remembered ? 'unlockable' : 'locked'
}
