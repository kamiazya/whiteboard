// A card slid back inside the root it would hang past has to stay inside when
// ITS OWN height changes afterwards: expanding "Decide each change" adds a
// row of 44px verbs per change, long after the first measure.

import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { Proposal, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { ProposalCard } from './ProposalCard.js'

afterEach(cleanup)

const ROOT_HEIGHT = 320
const EDGE_MARGIN_PX = 8

const canvas: SpatialCanvas = { nodes: [], edges: [] }

const proposal: Proposal = {
  id: 'p-many',
  changes: ['a', 'b', 'c'].map((id) => ({
    id: `c-${id}`,
    op: 'node.patch' as const,
    status: 'open' as const,
    nodeId: id,
    patch: { x: 40 },
    assumed: { x: 0 },
  })),
}

function mount(y: number) {
  return render(
    <div
      data-testid="fit-root"
      style={{ position: 'relative', width: 480, height: ROOT_HEIGHT, overflow: 'hidden' }}
    >
      <ProposalCard
        proposal={proposal}
        canvas={canvas}
        box={{ x: 20, y, width: 300, height: 0 }}
        palette={SPATIAL_LIGHT_PALETTE}
        onDecide={vi.fn()}
        onClose={vi.fn()}
      />
    </div>,
  )
}

/** How far the card's bottom edge sits above the root's bottom edge. */
async function bottomClearance(): Promise<number> {
  const root = (await page.getByTestId('fit-root').element()).getBoundingClientRect()
  const card = (await page.getByTestId('proposal-card').element()).getBoundingClientRect()
  return root.bottom - card.bottom
}

it('keeps the card inside the root when expanding per-change rows grows its height', async () => {
  // Measured collapsed at the top, then reopened with its bottom edge exactly
  // at the margin, so it needs no slide until it grows.
  mount(0)
  await expect.element(page.getByTestId('proposal-card')).toBeInTheDocument()
  const collapsed = (await page.getByTestId('proposal-card').element()).getBoundingClientRect()
  cleanup()

  mount(ROOT_HEIGHT - EDGE_MARGIN_PX - Math.ceil(collapsed.height))
  await expect.element(page.getByTestId('proposal-card')).toBeInTheDocument()
  expect(await bottomClearance()).toBeGreaterThanOrEqual(EDGE_MARGIN_PX)

  await userEvent.click(page.getByRole('button', { name: 'Decide each change' }))
  await expect.element(page.getByRole('button', { name: /^Adopt: / }).first()).toBeInTheDocument()

  // The premise: the card really did grow, or the clearance below proves nothing.
  const expanded = (await page.getByTestId('proposal-card').element()).getBoundingClientRect()
  expect(expanded.height).toBeGreaterThan(collapsed.height)

  await vi.waitFor(async () => {
    expect(await bottomClearance()).toBeGreaterThanOrEqual(EDGE_MARGIN_PX)
  })
})
