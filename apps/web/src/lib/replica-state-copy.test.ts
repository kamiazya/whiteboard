import { describe, expect, it } from 'vitest'
import { REPLICA_PAGE_STATES } from './replica-page-state.js'
import { lockedDetail, REPLICA_STATE_COPY } from './replica-state-copy.js'
import { REPLICA_TIER_COPY } from './replica-tier-copy.js'

// The same jargon guard PromoteWorkspaceSection.tier.test.ts uses — this
// copy reaches someone who has never heard "tier", "replica", "epoch" or
// "key", the same audience replica-tier-copy.ts already writes for.
const JARGON = /\b(tier|replica|epoch|key)\b/i

describe('REPLICA_STATE_COPY', () => {
  it('declares exactly the four page states, no more and no fewer', () => {
    expect(Object.keys(REPLICA_STATE_COPY).sort()).toEqual([...REPLICA_PAGE_STATES].sort())
  })

  it('needs-connection reuses the no-offline tier sentence verbatim — the SAME string, not a second spelling', () => {
    expect(REPLICA_STATE_COPY['needs-connection'].body).toBe(REPLICA_TIER_COPY['no-offline'])
  })

  it("removed states ADR-0042 decision 4's sentence verbatim", () => {
    expect(REPLICA_STATE_COPY.removed.body).toContain(
      'removed from this workspace; changes made since then were not sent',
    )
  })

  it('removed offers no action', () => {
    expect(REPLICA_STATE_COPY.removed.action).toBeUndefined()
  })

  it('locked and needs-connection each name an action', () => {
    expect(REPLICA_STATE_COPY.locked.action).toBe('Reconnect')
    expect(REPLICA_STATE_COPY['needs-connection'].action).toBe('Retry connection')
  })

  it('no body or action uses tier/replica/epoch/key jargon', () => {
    for (const { body, action } of Object.values(REPLICA_STATE_COPY)) {
      expect(body).not.toMatch(JARGON)
      if (action !== undefined) expect(action).not.toMatch(JARGON)
    }
  })
})

describe('lockedDetail', () => {
  it("names the bounded-tier sentence for a lapsed lease, so a person who was on borrowed time isn't left guessing why", () => {
    expect(lockedDetail('lapsed')).toBe(REPLICA_TIER_COPY.bounded)
  })

  it('says nothing extra for any other withheld reason', () => {
    expect(lockedDetail('unreachable')).toBeUndefined()
    expect(lockedDetail('unknown_credential')).toBeUndefined()
  })
})
