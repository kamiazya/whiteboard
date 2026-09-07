import type { Proposal } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { isOpenProposal, openChangeCount, openProposals } from './open-proposals.js'

function proposal(id: string, ...statuses: Array<'open' | 'adopted' | 'dismissed'>): Proposal {
  return {
    id,
    // `node.remove` carries `assumed` — the node as it stood, which is what
    // the renderer draws struck through. The verb is irrelevant here; what
    // these cases are about is the `status` beside it.
    changes: statuses.map((status, i) => ({
      id: `${id}-c${i}`,
      status,
      op: 'node.remove' as const,
      nodeId: `n${i}`,
      assumed: { id: `n${i}`, type: 'text' as const, x: 0, y: 0, width: 10, height: 10, text: '' },
    })),
  }
}

describe('open proposals', () => {
  it('keeps a batch open while one change waits', () => {
    expect(isOpenProposal(proposal('p', 'adopted', 'open', 'dismissed'))).toBe(true)
  })

  // Both verdicts close a change: an adopted one and a dismissed one have
  // each been answered, which is the whole question the count asks.
  it('closes a batch every change of which is decided, either way', () => {
    expect(isOpenProposal(proposal('p', 'adopted', 'dismissed'))).toBe(false)
    expect(isOpenProposal(proposal('p', 'adopted'))).toBe(false)
    expect(isOpenProposal(proposal('p', 'dismissed'))).toBe(false)
  })

  it('filters to the open ones, in the order given', () => {
    const list = [proposal('a', 'open'), proposal('b', 'adopted'), proposal('c', 'open')]
    expect(openProposals(list).map((p) => p.id)).toEqual(['a', 'c'])
  })

  it('counts the changes still waiting inside one proposal', () => {
    expect(openChangeCount(proposal('p', 'open', 'adopted', 'open'))).toBe(2)
  })
})
