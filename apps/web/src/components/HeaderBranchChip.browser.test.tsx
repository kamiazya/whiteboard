import type { BranchMeta } from '@kamiazya/whiteboard-mcp/api-contracts'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { UseBranchesResult } from '@/hooks/useBranches'

// Real pointer/keyboard interaction with the Radix dropdown/dialog/alert-dialog
// stack, which the jsdom-based HeaderBranchChip.test.tsx deliberately skips.

const branches: BranchMeta[] = [
  { name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '2026-04-23T00:00:00Z' },
  { name: 'feature-x', tipFrontiers: '', color: '#9333ea', createdAt: '2026-04-23T01:00:00Z' },
]

function makeState(): UseBranchesResult {
  return {
    state: { head: 'main', branches },
    loading: false,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
    createBranch: vi.fn().mockResolvedValue(branches[0]),
    deleteBranch: vi.fn().mockResolvedValue(undefined),
    getBranchStats: vi.fn().mockResolvedValue({ unmergedCommits: 2, isHead: false }),
    renameBranch: vi.fn().mockResolvedValue(branches[0]),
    setHead: vi.fn().mockResolvedValue({ head: 'feature-x' }),
    merge: vi.fn(),
  }
}

const stateHolder: { current: UseBranchesResult } = { current: makeState() }

vi.mock('@/hooks/useBranches', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useBranches')>('@/hooks/useBranches')
  return {
    ...actual,
    useBranches: () => stateHolder.current,
  }
})

import { HeaderBranchChip } from './HeaderBranchChip.js'

afterEach(() => {
  cleanup()
  stateHolder.current = makeState()
})

describe('HeaderBranchChip (browser — real Radix dropdown/dialog interaction)', () => {
  it('selecting another branch from the dropdown calls setHead', async () => {
    render(<HeaderBranchChip workspaceId="s1" slug="c1" />)
    const chip = screen.getByTestId('header-branch-chip')
    await userEvent.click(chip)

    const option = await screen.findByText('feature-x')
    await userEvent.click(option)

    expect(stateHolder.current.setHead).toHaveBeenCalledWith('feature-x')
  })

  it('kebab -> rename -> Enter calls renameBranch with the old and new names', async () => {
    // Rename is disabled while head === 'main', so switch HEAD first.
    stateHolder.current.state = { head: 'feature-x', branches }
    render(<HeaderBranchChip workspaceId="s1" slug="c1" />)
    const kebab = screen.getByTestId('header-branch-kebab')
    await userEvent.click(kebab)

    const renameItem = await screen.findByText(/Rename/)
    await userEvent.click(renameItem)

    const input = await screen.findByPlaceholderText('feature-x')
    await userEvent.clear(input)
    await userEvent.type(input, 'renamed-branch{Enter}')

    expect(stateHolder.current.renameBranch).toHaveBeenCalledWith('feature-x', 'renamed-branch')
  })

  it('kebab -> delete -> confirm shows the unmerged-commits warning and calls deleteBranch', async () => {
    stateHolder.current.state = { head: 'feature-x', branches }
    render(<HeaderBranchChip workspaceId="s1" slug="c1" />)
    const kebab = screen.getByTestId('header-branch-kebab')
    await userEvent.click(kebab)

    const deleteItem = await screen.findByText(/Delete/)
    await userEvent.click(deleteItem)

    await screen.findByText(/unmerged commits remain/)

    const confirmButton = await screen.findByRole('button', { name: 'Delete' })
    await userEvent.click(confirmButton)

    expect(stateHolder.current.deleteBranch).toHaveBeenCalledWith('feature-x')
  })

  it('inline "New branch…" form submits createBranch with the typed name', async () => {
    render(<HeaderBranchChip workspaceId="s1" slug="c1" />)
    const chip = screen.getByTestId('header-branch-chip')
    await userEvent.click(chip)

    const newBranchItem = await screen.findByText(/New branch/)
    await userEvent.click(newBranchItem)

    const input = await screen.findByPlaceholderText('New branch name')
    await userEvent.type(input, 'my-new-branch{Enter}')

    expect(stateHolder.current.createBranch).toHaveBeenCalledWith({ name: 'my-new-branch' })
  })

  it('surfaces createBranch rejection as a role=alert with the safe error copy', async () => {
    stateHolder.current.createBranch = vi.fn().mockRejectedValue(new Error('boom'))
    render(<HeaderBranchChip workspaceId="s1" slug="c1" />)
    const chip = screen.getByTestId('header-branch-chip')
    await userEvent.click(chip)

    const newBranchItem = await screen.findByText(/New branch/)
    await userEvent.click(newBranchItem)

    const input = await screen.findByPlaceholderText('New branch name')
    await userEvent.type(input, 'my-new-branch{Enter}')

    // The dropdown stays open on error so the user can retry, which puts the
    // error banner under Radix's aria-hidden'd background wrapper — query
    // with `hidden: true` to reach it.
    const alert = await screen.findByRole('alert', { hidden: true })
    expect(alert.textContent).toContain('Failed to create branch')
  })
})
