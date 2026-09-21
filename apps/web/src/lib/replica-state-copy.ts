import type { WithheldReason } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import type { ReplicaPageState } from './replica-page-state.js'
import { REPLICA_TIER_COPY } from './replica-tier-copy.js'

/**
 * Plain-language copy for the replica read page's six states (ADR-0042
 * decisions 3-6), declared once so a seventh state is a type error rather
 * than a place a second spelling can fork — no "tier"/"replica"/"epoch"/
 * "key" jargon, the same rule `replica-tier-copy.ts` writes under.
 */
export const REPLICA_STATE_COPY = {
  'needs-connection': {
    // The SAME sentence a workspace with no offline tier already states in
    // Settings — one definition of "nothing is kept here", not two.
    body: REPLICA_TIER_COPY['no-offline'],
    action: 'Retry connection',
  },
  readable: {
    body: 'the daemon that keeps this workspace is unreachable. This is the copy cached in this browser. Edits save here and ship to the daemon when it returns.',
    action: undefined,
  },
  locked: {
    body: 'A copy of this workspace is on this device, but it stays locked until the daemon that keeps it can be reached again.',
    action: 'Reconnect',
  },
  unlockable: {
    // The sentence `replica-key-wrap.ts` says the UI owes the user, and the
    // ONLY place it is written: the passkey provider is the recovery path
    // (ADR-0035, user decision 2026-09-21), so losing the credential loses
    // this copy. Said here rather than in the destructive-copy module,
    // which covers confirmations — this is not one, and putting it there
    // would have meant a sentence nothing shows.
    //
    // "Unlock" rather than "decrypt", and "this device" rather than "the
    // origin": the person is being told what they can do and what it costs,
    // not how it works.
    body: 'This device has a copy of this workspace that only your passkey can open. Unlocking does not need the daemon. If you lose that passkey, this copy cannot be read again — the daemon still keeps the workspace, so it can be pulled fresh.',
    action: 'Unlock with your passkey',
  },
  unpaired: {
    // The daemon was reached and no longer accepts this browser's pairing.
    // That is all a refused renewal proves — not that the person was
    // removed — so it says exactly that. No action here: pairing starts
    // from the daemon's own pair link, which this page cannot mint.
    body: 'This device is no longer paired with the daemon that keeps this workspace. Pair it again to continue.',
    action: undefined,
  },
  removed: {
    // ADR-0042 decision 4's sentence, verbatim — "discard-and-tell is a
    // ban": no export, no retry that would send anything, stated plainly
    // rather than read off a technical error.
    body: 'You were removed from this workspace; changes made since then were not sent.',
    action: undefined,
  },
} satisfies Record<ReplicaPageState, { body: string; action?: string }>

/**
 * An extra line for the 'locked' state when the reason is a lapsed
 * `bounded` lease — the person was on borrowed time, and the tier sentence
 * says so instead of leaving a lapse indistinguishable from any other
 * disconnection. `undefined` for every other reason: nothing else in
 * `WithheldReason` has a second sentence worth adding.
 */
export function lockedDetail(reason: WithheldReason): string | undefined {
  return reason === 'lapsed' ? REPLICA_TIER_COPY.bounded : undefined
}
