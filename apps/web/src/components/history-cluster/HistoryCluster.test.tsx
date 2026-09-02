import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HistoryCluster } from './HistoryCluster.js'

afterEach(cleanup)

describe('HistoryCluster', () => {
  it('undo/redo buttons call their handlers when enabled', () => {
    const onUndo = vi.fn()
    const onRedo = vi.fn()
    render(<HistoryCluster onUndo={onUndo} onRedo={onRedo} canUndo canRedo />)

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(onRedo).toHaveBeenCalledTimes(1)
  })

  it('disabled affordance: aria-disabled, handler gated, but still perceivable', () => {
    const onUndo = vi.fn()
    render(<HistoryCluster onUndo={onUndo} onRedo={vi.fn()} canUndo={false} canRedo={false} />)

    const undo = screen.getByRole('button', { name: 'Undo' })
    // aria-disabled instead of the native disabled attribute: a dead
    // disabled button swallows the pointer events tooltips need to answer
    // "why can't I press this".
    expect(undo.getAttribute('aria-disabled')).toBe('true')
    expect(undo.hasAttribute('disabled')).toBe(false)
    fireEvent.click(undo)
    expect(onUndo).not.toHaveBeenCalled()
  })

  it('advertises the keyboard shortcuts', () => {
    render(<HistoryCluster onUndo={vi.fn()} onRedo={vi.fn()} canUndo canRedo />)
    expect(
      screen.getByRole('button', { name: 'Undo' }).getAttribute('aria-keyshortcuts'),
    ).toContain('Z')
    expect(
      screen.getByRole('button', { name: 'Redo' }).getAttribute('aria-keyshortcuts'),
    ).toContain('Shift')
  })

  it('renders no version-history trigger without the versions capability', () => {
    render(<HistoryCluster onUndo={vi.fn()} onRedo={vi.fn()} canUndo canRedo />)
    expect(screen.queryByRole('button', { name: 'Version history' })).toBeNull()
  })

  it('with versions, the history trigger toggles the version panel', () => {
    render(
      <HistoryCluster
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        canUndo
        canRedo
        versions={{ workspaceId: 'ws-1', path: 'doc-a' }}
      />,
    )
    // VersionTimeline fetches on mount — jsdom has no fetch mock here, so
    // only assert the panel container appears/disappears.
    const trigger = screen.getByRole('button', { name: 'Version history' })
    expect(screen.queryByTestId('history-version-panel')).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByTestId('history-version-panel')).toBeTruthy()
    fireEvent.click(trigger)
    expect(screen.queryByTestId('history-version-panel')).toBeNull()
  })

  it('renders headerActions inside the opened version panel, beside the title rather than under the list', () => {
    render(
      <HistoryCluster
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        canUndo
        canRedo
        versions={{
          workspaceId: 'ws-1',
          path: 'doc-a',
          headerActions: <div data-testid="version-header-actions-slot">extra</div>,
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Version history' }))
    expect(screen.getByTestId('version-header-actions-slot')).toBeTruthy()
  })

  it('is marked as an editor overlay so canvas gestures ignore it', () => {
    render(<HistoryCluster onUndo={vi.fn()} onRedo={vi.fn()} canUndo canRedo />)
    const toolbar = screen.getByRole('toolbar', { name: 'History' })
    expect(toolbar.hasAttribute('data-editor-overlay')).toBe(true)
  })
})
