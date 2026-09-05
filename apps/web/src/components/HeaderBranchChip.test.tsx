import type { BranchMeta } from '@kamiazya/whiteboard-mcp/api-contracts'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DaemonApiContext } from '@/contexts/DaemonApiContext'
import type { UseBranchesResult } from '@/hooks/useBranches'

// Keep this test shallow.
// Radix dropdown content depends on portals and pointer interactions that are unstable in jsdom.
// Deeper switch/rename/delete/merge flows belong in browser or E2E coverage.

const branches: BranchMeta[] = [
  { name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '2026-04-23T00:00:00Z' },
  {
    name: 'feature-x',
    tipFrontiers: '',
    color: '#9333ea',
    createdAt: '2026-04-23T01:00:00Z',
  },
]

const state: { current: UseBranchesResult } = {
  current: {
    state: { head: 'main', branches },
    loading: false,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
    createBranch: vi.fn(),
    deleteBranch: vi.fn(),
    getBranchStats: vi.fn().mockResolvedValue({ unmergedCommits: 0, isHead: false }),
    renameBranch: vi.fn(),
    setHead: vi.fn(),
    merge: vi.fn(),
  },
}

const { useBranchesMock } = vi.hoisted(() => ({ useBranchesMock: vi.fn() }))

vi.mock('@/hooks/useBranches', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useBranches')>('@/hooks/useBranches')
  return {
    ...actual,
    useBranches: useBranchesMock,
  }
})

import { HeaderBranchChip } from './HeaderBranchChip.js'

function renderChip() {
  return render(
    <TooltipProvider>
      <HeaderBranchChip workspaceId="s1" path="c1" />
    </TooltipProvider>,
  )
}

afterEach(() => {
  cleanup()
  state.current.state.head = 'main'
  useBranchesMock.mockReset()
  useBranchesMock.mockImplementation(() => state.current)
})

useBranchesMock.mockImplementation(() => state.current)

describe('HeaderBranchChip', () => {
  it('renders the HEAD name in the chip trigger, capitalized for the default variation', () => {
    renderChip()
    const chip = screen.getByTestId('header-branch-chip')
    expect(chip.textContent).toContain('Main')
  })

  it('updates chip text when HEAD changes', () => {
    state.current.state.head = 'feature-x'
    renderChip()
    const chip = screen.getByTestId('header-branch-chip')
    expect(chip.textContent).toContain('feature-x')
  })

  it('applies the active branch color to the chip style', () => {
    state.current.state.head = 'feature-x'
    renderChip()
    const chip = screen.getByTestId('header-branch-chip')
    // jsdom converts hex colors to rgb().
    expect(chip.getAttribute('style') ?? '').toContain('rgb(147, 51, 234)')
  })

  it('renders the kebab trigger', () => {
    renderChip()
    expect(screen.getByTestId('header-branch-kebab')).not.toBeNull()
  })

  it('uses an English aria-label on the chip trigger', () => {
    renderChip()
    const chip = screen.getByTestId('header-branch-chip')
    expect(chip.getAttribute('aria-label')).toContain('Switch variation')
    expect(chip.getAttribute('aria-label')).toContain('current: main')
  })

  it('uses an English aria-label on the kebab trigger', () => {
    renderChip()
    const kebab = screen.getByTestId('header-branch-kebab')
    expect(kebab.getAttribute('aria-label')).toBe('Variation actions')
  })
})

describe('HeaderBranchChip keeper wiring', () => {
  /**
   * This used to assert that the chip threaded a fetch into `useBranches` —
   * once for the same-origin default and once for a mounted daemon provider.
   * That coupling is gone on purpose: WHICH keeper answers now comes from
   * `BranchesBackendContext`, so a component passes only the document it is
   * about and cannot get the keeper decision wrong.
   *
   * The property those two cases protected — that a mounted daemon fetch is
   * the one the branch calls actually go through — did not vanish with them.
   * It moved to `useBranches.test.ts`, which drives it through the provider
   * the hook now reads.
   */
  it('passes the document only, leaving the keeper to the context', () => {
    const daemonFetch = vi.fn() as unknown as typeof fetch
    render(
      <TooltipProvider>
        <DaemonApiContext.Provider value={daemonFetch}>
          <HeaderBranchChip workspaceId="s1" path="c1" />
        </DaemonApiContext.Provider>
      </TooltipProvider>,
    )
    // Exactly two arguments, in both the provider and no-provider cases: a
    // third would mean a caller had a say in the keeper again.
    expect(useBranchesMock).toHaveBeenLastCalledWith('s1', 'c1')
    renderChip()
    expect(useBranchesMock).toHaveBeenLastCalledWith('s1', 'c1')
  })
})

describe('HeaderBranchChip refreshSignal', () => {
  it('refetches when refreshSignal changes but not on initial mount', () => {
    const { rerender } = render(
      <TooltipProvider>
        <HeaderBranchChip workspaceId="s1" path="c1" refreshSignal={0} />
      </TooltipProvider>,
    )
    expect(state.current.refetch).not.toHaveBeenCalled()

    rerender(
      <TooltipProvider>
        <HeaderBranchChip workspaceId="s1" path="c1" refreshSignal={1} />
      </TooltipProvider>,
    )
    expect(state.current.refetch).toHaveBeenCalledTimes(1)
  })
})
