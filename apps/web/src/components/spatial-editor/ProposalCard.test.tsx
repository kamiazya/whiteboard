// @vitest-environment jsdom

/**
 * The card is where a proposal is DECIDED, so who proposed it belongs on it:
 * the Proposals panel row names the author, and a person adopting from the
 * board is owed the same provenance.
 */

import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { Proposal, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProposalCard } from './ProposalCard'

afterEach(cleanup)

const canvas: SpatialCanvas = { nodes: [], edges: [] }

const proposal: Proposal = {
  id: 'p1',
  changes: [
    {
      id: 'c1',
      op: 'node.patch',
      status: 'open',
      nodeId: 'a',
      patch: { x: 40 },
      assumed: { x: 0 },
    },
  ],
}

function renderCard(subject: Proposal) {
  render(
    <ProposalCard
      proposal={subject}
      canvas={canvas}
      box={{ x: 0, y: 0, width: 200, height: 0 }}
      palette={SPATIAL_LIGHT_PALETTE}
      onDecide={vi.fn()}
      onClose={vi.fn()}
    />,
  )
  return screen.getByRole('dialog', { name: 'Proposed changes' })
}

describe('ProposalCard author', () => {
  it('names who proposed the changes inside the dialog, as plain text', () => {
    const card = renderCard({ ...proposal, author: 'claude-code/1.0' })

    expect(within(card).getByText('by claude-code/1.0')).not.toBeNull()
  })

  it('says nothing about an author when the proposal carries none', () => {
    const card = renderCard(proposal)

    expect(within(card).queryByText(/^by\b/)).toBeNull()
  })
})
