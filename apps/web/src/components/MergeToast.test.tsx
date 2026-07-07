import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MergeToast } from './MergeToast.js'
import {
  MERGE_COMMITTED_EVENT,
  dispatchMergeCommitted,
  type MergeCommittedDetail,
} from '@/lib/merge-committed-event'

const baseDetail: MergeCommittedDetail = {
  workspaceId: 's1',
  slug: 'c1',
  sourceName: 'feature-a',
  targetName: 'main',
  newCount: 2,
  changedCount: 1,
  conflictCount: 0,
  preMergeVersionId: 'v-pre',
  newElementIds: [],
  conflictElementIds: [],
}

beforeEach(() => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('MergeToast', () => {
  it('shows the toast when the event is received', () => {
    render(<MergeToast workspaceId="s1" slug="c1" />)
    expect(screen.queryByTestId('merge-toast')).toBeNull()
    act(() => dispatchMergeCommitted(baseDetail))
    expect(screen.getByTestId('merge-toast')).toBeTruthy()
    expect(screen.getByText(/Merged changes from «feature-a»/)).toBeTruthy()
    expect(screen.getByText(/2 added · 1 changed/)).toBeTruthy()
  })

  it('ignores events for a different session or slug', () => {
    render(<MergeToast workspaceId="s1" slug="c1" />)
    act(() => dispatchMergeCommitted({ ...baseDetail, workspaceId: 'other' }))
    expect(screen.queryByTestId('merge-toast')).toBeNull()
  })

  it('ignores a malformed detail without crashing', () => {
    render(<MergeToast workspaceId="s1" slug="c1" />)
    act(() => {
      window.dispatchEvent(
        new CustomEvent(MERGE_COMMITTED_EVENT, { detail: { ...baseDetail, newCount: 'nope' } }),
      )
    })
    expect(screen.queryByTestId('merge-toast')).toBeNull()
  })

  it('shows "No content changes" when there is no diff', () => {
    render(<MergeToast workspaceId="s1" slug="c1" />)
    act(() =>
      dispatchMergeCommitted({ ...baseDetail, newCount: 0, changedCount: 0, conflictCount: 0 }),
    )
    expect(screen.getByText(/No content changes/)).toBeTruthy()
  })

  it('shows the Undo button when preMergeVersionId is present', () => {
    render(<MergeToast workspaceId="s1" slug="c1" />)
    act(() => dispatchMergeCommitted(baseDetail))
    expect(screen.getByTestId('merge-toast-undo')).toBeTruthy()
  })

  it('hides the Undo button when preMergeVersionId is missing', () => {
    render(<MergeToast workspaceId="s1" slug="c1" />)
    act(() => dispatchMergeCommitted({ ...baseDetail, preMergeVersionId: undefined }))
    expect(screen.queryByTestId('merge-toast-undo')).toBeNull()
  })

  it('posts restore and calls onRestored when Undo is clicked', async () => {
    const onRestored = vi.fn()
    render(<MergeToast workspaceId="s1" slug="c1" onRestored={onRestored} />)
    act(() => dispatchMergeCommitted(baseDetail))
    fireEvent.click(screen.getByTestId('merge-toast-undo'))
    await waitFor(() => {
      expect(fetch).toHaveBeenCalled()
    })
    await waitFor(() => expect(onRestored).toHaveBeenCalled())
    // The toast closes after undo.
    await waitFor(() => expect(screen.queryByTestId('merge-toast')).toBeNull())
  })

  it('closes immediately when the close button is clicked', () => {
    render(<MergeToast workspaceId="s1" slug="c1" />)
    act(() => dispatchMergeCommitted(baseDetail))
    fireEvent.click(screen.getByTestId('merge-toast-close'))
    expect(screen.queryByTestId('merge-toast')).toBeNull()
  })
})
