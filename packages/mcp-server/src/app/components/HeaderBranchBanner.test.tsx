import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import type { BranchMeta, UseBranchesResult } from '../hooks/useBranches.js'

// MergeDialog touches Excalidraw, so stub it to avoid roughjs resolution in tests.
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: () => null,
  exportToBlob: () => Promise.resolve(null),
}))
vi.mock('@excalidraw/excalidraw/index.css', () => ({}))

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

vi.mock('../hooks/useBranches.js', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useBranches.js')>(
    '../hooks/useBranches.js',
  )
  return {
    ...actual,
    useBranches: () => state.current,
  }
})

import { HeaderBranchBanner } from './HeaderBranchBanner.js'

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
})
