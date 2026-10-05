// @vitest-environment jsdom

/**
 * The passage card is where a proposed rewrite is DECIDED, so it names who
 * proposed it the way the Proposals panel row and the canvas card do.
 */

import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassageProposalCard, type PassageProposalCardProps } from './PassageProposalCard'

afterEach(cleanup)

function renderCard(extra: Partial<PassageProposalCardProps>) {
  render(
    <PassageProposalCard
      current="Thursday"
      proposed="Friday"
      conflicted={false}
      bodyLength={30}
      at={{ x: 0, y: 0 }}
      onDecide={vi.fn()}
      onClose={vi.fn()}
      {...extra}
    />,
  )
  return screen.getByRole('dialog', { name: 'Proposed change to this passage' })
}

describe('PassageProposalCard author', () => {
  it('names who proposed the change inside the dialog, as plain text', () => {
    const card = renderCard({ author: 'claude-code/1.0' })

    expect(within(card).getByText('by claude-code/1.0')).not.toBeNull()
  })

  it('says nothing about an author when the proposal carries none', () => {
    const card = renderCard({})

    expect(within(card).queryByText(/^by\b/)).toBeNull()
  })
})
