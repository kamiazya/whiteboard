import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import {
  dispatchMergeCommitted,
  MERGE_COMMITTED_EVENT,
  type MergeCommittedDetail,
} from '../lib/merge-committed-event.js'
import { MergeToast } from './MergeToast.js'

const baseDetail: MergeCommittedDetail = {
  workspaceId: 's1',
  path: 'c1',
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
    render(<MergeToast workspaceId="s1" path="c1" />)
    expect(screen.queryByTestId('merge-toast')).toBeNull()
    act(() => dispatchMergeCommitted(baseDetail))
    expect(screen.getByTestId('merge-toast')).toBeTruthy()
    expect(screen.getByText(/Combined changes from «feature-a»/)).toBeTruthy()
    expect(screen.getByText(/2 added · 1 changed/)).toBeTruthy()
  })

  it('ignores events for a different session or path', () => {
    render(<MergeToast workspaceId="s1" path="c1" />)
    act(() => dispatchMergeCommitted({ ...baseDetail, workspaceId: 'other' }))
    expect(screen.queryByTestId('merge-toast')).toBeNull()
  })

  it('ignores a malformed detail without crashing', () => {
    render(<MergeToast workspaceId="s1" path="c1" />)
    act(() => {
      window.dispatchEvent(
        new CustomEvent(MERGE_COMMITTED_EVENT, { detail: { ...baseDetail, newCount: 'nope' } }),
      )
    })
    expect(screen.queryByTestId('merge-toast')).toBeNull()
  })

  it('shows "No content changes" when there is no diff', () => {
    render(<MergeToast workspaceId="s1" path="c1" />)
    act(() =>
      dispatchMergeCommitted({ ...baseDetail, newCount: 0, changedCount: 0, conflictCount: 0 }),
    )
    expect(screen.getByText(/No content changes/)).toBeTruthy()
  })

  it('shows the Undo button when preMergeVersionId is present', () => {
    render(<MergeToast workspaceId="s1" path="c1" />)
    act(() => dispatchMergeCommitted(baseDetail))
    expect(screen.getByTestId('merge-toast-undo')).toBeTruthy()
  })

  it('hides the Undo button when preMergeVersionId is missing', () => {
    render(<MergeToast workspaceId="s1" path="c1" />)
    act(() => dispatchMergeCommitted({ ...baseDetail, preMergeVersionId: undefined }))
    expect(screen.queryByTestId('merge-toast-undo')).toBeNull()
  })

  it('posts restore and calls onRestored when Undo is clicked', async () => {
    const onRestored = vi.fn()
    render(<MergeToast workspaceId="s1" path="c1" onRestored={onRestored} />)
    act(() => dispatchMergeCommitted(baseDetail))
    fireEvent.click(screen.getByTestId('merge-toast-undo'))
    await waitFor(() => {
      expect(fetch).toHaveBeenCalled()
    })
    await waitFor(() => expect(onRestored).toHaveBeenCalled())
    // The toast closes after undo.
    await waitFor(() => expect(screen.queryByTestId('merge-toast')).toBeNull())
  })

  it('encodes preMergeVersionId in the restore URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<MergeToast workspaceId="s1" path="c1" />)
    act(() => dispatchMergeCommitted({ ...baseDetail, preMergeVersionId: 'v/pre?weird#id' }))
    fireEvent.click(screen.getByTestId('merge-toast-undo'))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string
    expect(calledUrl).toBe('/api/workspaces/s1/documents/c1/versions/v%2Fpre%3Fweird%23id/restore')
  })

  it('restores the canvas the merge happened on, not the currently selected one', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<MergeToast workspaceId="s1" path="c1" />)
    act(() => dispatchMergeCommitted(baseDetail))
    // Simulate switching to a different canvas while the toast is still open;
    // the toast state is not keyed on workspaceId/path so it survives the switch.
    rerender(<MergeToast workspaceId="s1" path="c2" />)
    fireEvent.click(screen.getByTestId('merge-toast-undo'))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string
    expect(calledUrl).toBe('/api/workspaces/s1/documents/c1/versions/v-pre/restore')
  })

  it('closes immediately when the close button is clicked', () => {
    render(<MergeToast workspaceId="s1" path="c1" />)
    act(() => dispatchMergeCommitted(baseDetail))
    fireEvent.click(screen.getByTestId('merge-toast-close'))
    expect(screen.queryByTestId('merge-toast')).toBeNull()
  })

  it('keeps the toast open and shows an error when restore responds non-ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ title: 'nope' }), { status: 409 })),
    )
    const onRestored = vi.fn()
    render(<MergeToast workspaceId="s1" path="c1" onRestored={onRestored} />)
    act(() => dispatchMergeCommitted(baseDetail))
    fireEvent.click(screen.getByTestId('merge-toast-undo'))
    await waitFor(() => {
      expect(screen.getByTestId('merge-toast-undo-error')).toBeTruthy()
    })
    expect(onRestored).not.toHaveBeenCalled()
    // The toast (and its retry affordance) stays visible after a failed restore.
    expect(screen.getByTestId('merge-toast')).toBeTruthy()
    expect(screen.getByTestId('merge-toast-undo')).toBeTruthy()
  })

  it('auto-dismisses after mouseleave even when the 5s timer already elapsed while hovered', () => {
    vi.useFakeTimers()
    render(<MergeToast workspaceId="s1" path="c1" />)
    act(() => dispatchMergeCommitted(baseDetail))
    const toast = screen.getByTestId('merge-toast')
    fireEvent.mouseEnter(toast)
    // The auto-dismiss timer fires while still hovered, so it must not close yet.
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(screen.getByTestId('merge-toast')).toBeTruthy()
    // Leaving after the timer already elapsed must arm a fresh timer instead of
    // leaving the toast stuck open forever.
    fireEvent.mouseLeave(toast)
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(screen.queryByTestId('merge-toast')).toBeNull()
  })

  it('keeps the toast open and shows an error when restore throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const onRestored = vi.fn()
    render(<MergeToast workspaceId="s1" path="c1" onRestored={onRestored} />)
    act(() => dispatchMergeCommitted(baseDetail))
    fireEvent.click(screen.getByTestId('merge-toast-undo'))
    await waitFor(() => {
      expect(screen.getByTestId('merge-toast-undo-error')).toBeTruthy()
    })
    expect(onRestored).not.toHaveBeenCalled()
    expect(screen.getByTestId('merge-toast')).toBeTruthy()
  })

  it('restores through the daemon-context fetch instead of the same-origin apiFetch', async () => {
    const daemonFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const globalFetch = vi.mocked(fetch)
    const onRestored = vi.fn()
    render(
      <DaemonApiContext.Provider value={daemonFetch}>
        <MergeToast workspaceId="s1" path="c1" onRestored={onRestored} />
      </DaemonApiContext.Provider>,
    )
    act(() => dispatchMergeCommitted(baseDetail))
    fireEvent.click(screen.getByTestId('merge-toast-undo'))
    await waitFor(() => expect(onRestored).toHaveBeenCalled())
    expect(daemonFetch).toHaveBeenCalledWith(
      '/api/workspaces/s1/documents/c1/versions/v-pre/restore',
      { method: 'POST' },
    )
    expect(globalFetch).not.toHaveBeenCalled()
  })
})
