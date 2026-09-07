// @vitest-environment jsdom

/**
 * The Proposals panel is an INDEX (ADR-0029 decision 1): it says what is
 * waiting and takes you to where it is drawn. It is not a second place to
 * decide — the card on the board is the one place a change is adopted, and
 * a panel that grew its own Adopt would let the two disagree about what is
 * being answered.
 */

import type { Proposal } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProposalsPanel } from './ProposalsPanel'

afterEach(cleanup)

function moveNode(id: string, status: 'open' | 'adopted'): Proposal['changes'][number] {
  return { id, op: 'node.patch', status, nodeId: 'n1', patch: { x: 40 }, assumed: { x: 0 } }
}

const waiting: Proposal = {
  id: 'p1',
  createdAt: '2026-09-06T00:00:00.000Z',
  changes: [moveNode('c1', 'open'), moveNode('c2', 'adopted')],
}

const decided: Proposal = { id: 'p2', changes: [moveNode('c3', 'adopted')] }

describe('ProposalsPanel', () => {
  it('lists only what is still waiting, and says how much of each is', () => {
    render(<ProposalsPanel proposals={[waiting, decided]} onOpen={() => {}} />)

    const rows = screen.getAllByRole('button')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('1 change waiting')
  })

  it('names the verbs in words rather than in op ids', () => {
    render(<ProposalsPanel proposals={[waiting]} onOpen={() => {}} />)

    expect(screen.getByRole('button').textContent).toContain('Move or restyle a node')
    expect(screen.getByRole('button').textContent).not.toContain('node.patch')
  })

  // Decision 1 again: the row is the way BACK to the board, so pressing it
  // hands the proposal's id to whoever can reveal it. It decides nothing.
  it('hands the row press to the host, which reveals it in place', () => {
    const onOpen = vi.fn()
    render(<ProposalsPanel proposals={[waiting]} onOpen={onOpen} />)

    fireEvent.click(screen.getByRole('button'))
    expect(onOpen).toHaveBeenCalledWith('p1')
  })

  // A host with no in-place surface to jump to (a markdown body draws its
  // passages itself and has no viewport to move) still gets the index. The
  // row stops being a button rather than becoming a dead one.
  it('draws rows that are not pressable when the host cannot reveal one', () => {
    render(<ProposalsPanel proposals={[waiting]} />)

    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByText(/1 change waiting/)).not.toBeNull()
  })

  it('says what an empty panel means rather than drawing nothing', () => {
    render(<ProposalsPanel proposals={[decided]} onOpen={() => {}} />)

    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByText(/Nothing waiting/)).not.toBeNull()
  })
})
