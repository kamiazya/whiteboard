/**
 * The replica read page's four degradation states (ADR-0042 decisions 3-5),
 * as a pure function of what the renewal answered and what the S4a holder
 * knows about this workspace's key — never of the tier or of whether a
 * registry entry exists, both of which the caller has already resolved
 * before this function is asked (see `replica-page-state.ts`'s own header).
 *
 * Exhaustive over the full (renewal x key) input space rather than a
 * sample: the space is small and finite (2 x 11 = 22), and it is exactly
 * what a dropped arm — or a fifth state nobody wired a case for — would
 * change the count of.
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

function expectedState(renewal: ReplicaRenewalInput, key: ReplicaKeyInput): ReplicaPageState {
  if (renewal === 'refused') return 'removed'
  if (key === 'missing') return 'needs-connection'
  if (key === 'readable') return 'readable'
  const reason = key.withheld
  if ((REMOVED_REASONS as readonly string[]).includes(reason)) return 'removed'
  return 'locked'
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

  it('is exhaustive: every (renewal x key) input maps to exactly one of the four states, 22 total', () => {
    const tally: Record<ReplicaPageState, number> = {
      'needs-connection': 0,
      readable: 0,
      locked: 0,
      removed: 0,
    }
    let total = 0
    for (const renewal of RENEWALS) {
      for (const key of keys) {
        const state = replicaPageState({ renewal, key })
        expect(REPLICA_PAGE_STATES).toContain(state)
        expect(state).toBe(expectedState(renewal, key))
        tally[state] += 1
        total += 1
      }
    }
    expect(total).toBe(22)
    expect(tally).toEqual({ 'needs-connection': 1, readable: 1, locked: 4, removed: 16 })
  })

  it('fails closed: a refused renewal is always removed, even with a key still held readable', () => {
    for (const key of keys) {
      expect(replicaPageState({ renewal: 'refused', key })).toBe('removed')
    }
  })

  it('never reports removed on a network condition (unreachable renewal, unreachable/lapsed key)', () => {
    expect(replicaPageState({ renewal: 'unreachable', key: { withheld: 'unreachable' } })).toBe(
      'locked',
    )
    expect(replicaPageState({ renewal: 'unreachable', key: { withheld: 'lapsed' } })).toBe('locked')
  })

  it.each(
    REMOVED_REASONS,
  )('a daemon-reached membership refusal (%s) is removed under an unreachable renewal', (reason) => {
    expect(replicaPageState({ renewal: 'unreachable', key: { withheld: reason } })).toBe('removed')
  })

  it.each(LOCKED_REASONS)('%s is locked under an unreachable renewal', (reason) => {
    expect(replicaPageState({ renewal: 'unreachable', key: { withheld: reason } })).toBe('locked')
  })
})
