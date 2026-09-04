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

  it('is marked as an editor overlay so canvas gestures ignore it', () => {
    render(<HistoryCluster onUndo={vi.fn()} onRedo={vi.fn()} canUndo canRedo />)
    const toolbar = screen.getByRole('toolbar', { name: 'Undo and redo' })
    expect(toolbar.hasAttribute('data-editor-overlay')).toBe(true)
  })
})
