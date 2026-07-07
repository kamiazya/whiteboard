import type { BranchMeta } from '@kamiazya/whiteboard-mcp/api-contracts'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UseBranchesResult } from '@/hooks/useBranches'
import { dispatchMergeCommitted, type MergeCommittedDetail } from '@/lib/merge-committed-event'

// MergeDialog touches Excalidraw-adjacent thumbnail fetches; nothing to stub here since
// this component only mounts MergeDialog behind a closed `open={false}` state by default.

const branches: BranchMeta[] = [
  { name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '2026-04-23T00:00:00Z' },
  { name: 'feature-a', tipFrontiers: '', color: '#9333ea', createdAt: '2026-04-23T01:00:00Z' },
]

const state: { current: UseBranchesResult } = {
  current: {
    state: { head: 'feature-a', branches },
    loading: false,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
    createBranch: vi.fn(),
    deleteBranch: vi.fn(),
    getBranchStats: vi.fn().mockResolvedValue({ unmergedCommits: 3, isHead: true }),
    renameBranch: vi.fn(),
    setHead: vi.fn(),
    merge: vi.fn(),
  },
}

vi.mock('@/hooks/useBranches', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useBranches')>('@/hooks/useBranches')
  return {
    ...actual,
    useBranches: () => state.current,
  }
})

import { HeaderBranchBanner } from './HeaderBranchBanner.js'

function baseDetail(overrides: Partial<MergeCommittedDetail> = {}): MergeCommittedDetail {
  return {
    workspaceId: 's1',
    slug: 'c1',
    sourceName: 'feature-a',
    targetName: 'main',
    newCount: 0,
    changedCount: 0,
    conflictCount: 0,
    newElementIds: [],
    conflictElementIds: [],
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  state.current.state.head = 'feature-a'
  state.current.getBranchStats = vi.fn().mockResolvedValue({ unmergedCommits: 3, isHead: true })
})

describe('HeaderBranchBanner', () => {
  it('does not render the banner when HEAD is main', async () => {
    state.current.state.head = 'main'
    render(<HeaderBranchBanner workspaceId="s1" slug="c1" />)
    // Wait for the initial fetch path.
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId('header-branch-banner')).toBeNull()
  })

  it('renders the banner when HEAD is not main and unmergedCommits > 0', async () => {
    render(<HeaderBranchBanner workspaceId="s1" slug="c1" />)
    await waitFor(() => {
      expect(screen.getByTestId('header-branch-banner')).toBeTruthy()
    })
    expect(screen.getByText(/changes not yet merged into/)).toBeTruthy()
    expect(screen.getByText(/3/)).toBeTruthy()
    expect(screen.getByTestId('header-branch-banner-merge')).toBeTruthy()
  })

  it('hides the banner when unmergedCommits is 0', async () => {
    state.current.getBranchStats = vi.fn().mockResolvedValue({ unmergedCommits: 0, isHead: true })
    render(<HeaderBranchBanner workspaceId="s1" slug="c1" />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId('header-branch-banner')).toBeNull()
  })

  it('does NOT register an excalidraw:head_changed listener (callback model, not window bus)', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    render(<HeaderBranchBanner workspaceId="s1" slug="c1" />)
    const registeredEvents = addSpy.mock.calls.map((call) => call[0])
    expect(registeredEvents).not.toContain('excalidraw:head_changed')
    addSpy.mockRestore()
  })

  it('re-fetches stats on a matching merge_committed event', async () => {
    render(<HeaderBranchBanner workspaceId="s1" slug="c1" />)
    await waitFor(() => {
      expect(screen.getByTestId('header-branch-banner')).toBeTruthy()
    })
    const callsBefore = (state.current.getBranchStats as ReturnType<typeof vi.fn>).mock.calls.length

    await act(async () => {
      dispatchMergeCommitted(baseDetail())
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(
        (state.current.getBranchStats as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThan(callsBefore)
    })
  })

  it('ignores a merge_committed event for a different workspace/slug', async () => {
    render(<HeaderBranchBanner workspaceId="s1" slug="c1" />)
    await waitFor(() => {
      expect(screen.getByTestId('header-branch-banner')).toBeTruthy()
    })
    const callsBefore = (state.current.getBranchStats as ReturnType<typeof vi.fn>).mock.calls.length

    await act(async () => {
      dispatchMergeCommitted(baseDetail({ workspaceId: 'other-workspace' }))
      await Promise.resolve()
    })

    expect((state.current.getBranchStats as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsBefore,
    )
  })

  it('ignores a Zod-invalid merge_committed event detail', async () => {
    render(<HeaderBranchBanner workspaceId="s1" slug="c1" />)
    await waitFor(() => {
      expect(screen.getByTestId('header-branch-banner')).toBeTruthy()
    })
    const callsBefore = (state.current.getBranchStats as ReturnType<typeof vi.fn>).mock.calls.length

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('excalidraw:merge_committed', { detail: { not: 'valid' } }),
      )
      await Promise.resolve()
    })

    expect((state.current.getBranchStats as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsBefore,
    )
  })
})
