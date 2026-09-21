/**
 * The replica read page's six degradation states (ADR-0042 decisions 3-6),
 * as a pure function of what the renewal answered, what the S4a holder
 * knows about this workspace's key, and whether this device remembered a
 * wrapped one — never of the tier or of whether a registry entry exists,
 * both of which the caller has already resolved before this function is
 * asked (see `replica-page-state.ts`'s own header).
 *
 * Exhaustive over the full (renewal x key x remembered) input space rather
 * than a sample: the space is small and finite (2 x 11 x 2 = 44), and it is
 * exactly what a dropped arm — or a seventh state nobody wired a case for —
 * would change the count of.
 */
import { membershipRefusalSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import type { WithheldReason } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import { describe, expect, it } from 'vitest'
import {
  REPLICA_PAGE_STATES,
  type ReplicaKeyInput,
  type ReplicaPageState,
  type ReplicaRenewalInput,
  replicaPageState,
} from './replica-page-state.js'

const REFUSAL_REASONS = membershipRefusalSchema.shape.error.options
// The two withheld reasons the holder can answer that are not a membership
// refusal from the daemon — a network condition, not a daemon decision.
const NON_REFUSAL_WITHHELD_REASONS: readonly WithheldReason[] = ['unreachable', 'lapsed']

const RENEWALS: readonly ReplicaRenewalInput[] = ['unreachable', 'refused']
const REMEMBERED: readonly boolean[] = [false, true]

// One entry per state, so the totality check below (every input maps
// somewhere, every state is reachable) is stated once rather than by
// re-deriving REPLICA_PAGE_STATES's own length.
const REMOVED_REASONS = [
  'not_a_member',
  'unknown_profile',
  'replica_not_allowed',
  'unknown_workspace',
  'invalid_workspace_id',
] as const
const LOCKED_REASONS = [
  'unreachable',
  'lapsed',
  'unknown_credential',
  'requires_person_session',
] as const

function expectedState(
  renewal: ReplicaRenewalInput,
  key: ReplicaKeyInput,
  remembered: boolean,
): ReplicaPageState {
  if (renewal === 'refused') return 'unpaired'
  if (key === 'readable') return 'readable'
  if (key === 'missing') return remembered ? 'unlockable' : 'needs-connection'
  const reason = key.withheld
  if ((REMOVED_REASONS as readonly string[]).includes(reason)) return 'removed'
  return remembered ? 'unlockable' : 'locked'
}

function allKeyInputs(): ReplicaKeyInput[] {
  const withheldReasons: WithheldReason[] = [...REFUSAL_REASONS, ...NON_REFUSAL_WITHHELD_REASONS]
  return ['readable', 'missing', ...withheldReasons.map((reason) => ({ withheld: reason }))]
}

describe('replicaPageState', () => {
  const keys = allKeyInputs()

  it('the fixture reaches every membership refusal reason and both non-refusal withheld reasons', () => {
    expect(REFUSAL_REASONS.length).toBe(7)
    expect(keys.length).toBe(11)
  })

  it('is exhaustive: every (renewal x key x remembered) input maps to exactly one of the six states, 44 total', () => {
    const tally: Record<ReplicaPageState, number> = {
      'needs-connection': 0,
      readable: 0,
      locked: 0,
      unlockable: 0,
      unpaired: 0,
      removed: 0,
    }
    let total = 0
    for (const renewal of RENEWALS) {
      for (const key of keys) {
        for (const remembered of REMEMBERED) {
          const state = replicaPageState({ renewal, key, remembered })
          expect(REPLICA_PAGE_STATES).toContain(state)
          expect(state).toBe(expectedState(renewal, key, remembered))
          tally[state] += 1
          total += 1
        }
      }
    }
    expect(total).toBe(44)
    expect(tally).toEqual({
      'needs-connection': 1,
      readable: 2,
      locked: 4,
      unlockable: 5,
      unpaired: 22,
      removed: 10,
    })
  })

  it('a remembered blob never overrides a daemon that has spoken', () => {
    // ADR-0042 decision 3: revocation takes effect the moment the device
    // reaches the daemon. A refused renewal and a membership refusal are
    // both the daemon reaching this device, so offering an unlock past
    // either would make a local copy outrank the decision that revoked it.
    for (const key of keys) {
      expect(replicaPageState({ renewal: 'refused', key, remembered: true })).toBe('unpaired')
    }
    for (const reason of REMOVED_REASONS) {
      expect(
        replicaPageState({ renewal: 'unreachable', key: { withheld: reason }, remembered: true }),
      ).toBe('removed')
    }
  })

  it('a key already readable is never an unlock offer', () => {
    // Asking someone to prove themselves for something already open is the
    // prompt this whole design exists to avoid.
    expect(replicaPageState({ renewal: 'unreachable', key: 'readable', remembered: true })).toBe(
      'readable',
    )
  })

  it('fails closed: a refused renewal is always unpaired, even with a key still held readable', () => {
    for (const key of keys) {
      expect(replicaPageState({ renewal: 'refused', key, remembered: false })).toBe('unpaired')
    }
  })

  it('a refused renewal is never removed: the token route cannot speak for membership', () => {
    // The same 403 answers a revoked grant and a daemon whose grant store was
    // lost; the person's membership is only ever decided by the key route.
    for (const key of keys) {
      expect(replicaPageState({ renewal: 'refused', key, remembered: false })).not.toBe('removed')
    }
  })

  it('never reports removed on a network condition (unreachable renewal, unreachable/lapsed key)', () => {
    expect(
      replicaPageState({
        renewal: 'unreachable',
        key: { withheld: 'unreachable' },
        remembered: false,
      }),
    ).toBe('locked')
    expect(
      replicaPageState({ renewal: 'unreachable', key: { withheld: 'lapsed' }, remembered: false }),
    ).toBe('locked')
  })

  it.each(
    REMOVED_REASONS,
  )('a daemon-reached membership refusal (%s) is removed under an unreachable renewal', (reason) => {
    expect(
      replicaPageState({ renewal: 'unreachable', key: { withheld: reason }, remembered: false }),
    ).toBe('removed')
  })

  it.each(LOCKED_REASONS)('%s is locked under an unreachable renewal', (reason) => {
    expect(
      replicaPageState({ renewal: 'unreachable', key: { withheld: reason }, remembered: false }),
    ).toBe('locked')
  })
})
