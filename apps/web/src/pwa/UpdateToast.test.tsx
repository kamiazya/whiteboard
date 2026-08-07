import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateToast } from './UpdateToast.js'

afterEach(cleanup)

describe('UpdateToast', () => {
  it('renders the update prompt with a Reload action', () => {
    render(<UpdateToast onReload={vi.fn()} onDismiss={vi.fn()} />)

    expect(screen.getByText(/Update available/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })

  it('invokes onReload exactly once when Reload is clicked', () => {
    const onReload = vi.fn()
    render(<UpdateToast onReload={onReload} onDismiss={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))

    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('renders overlaid on the viewport, not in document flow', () => {
    // The app shell fills 100dvh, so a static toast appended to <body> lands
    // BELOW the viewport and is never seen — the exact failure observed on
    // the deployed preview (toast at y === viewport height). Fixed
    // positioning with a stacking z-index is what keeps it visible.
    render(<UpdateToast onReload={vi.fn()} onDismiss={vi.fn()} />)

    const toast = screen.getByRole('status')
    expect(toast.className).toMatch(/\bfixed\b/)
    expect(toast.className).toMatch(/\bz-\d+\b/)
  })

  it('hides the toast and calls onDismiss when Dismiss is clicked', () => {
    const onDismiss = vi.fn()
    render(<UpdateToast onReload={vi.fn()} onDismiss={onDismiss} />)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Update available/i)).toBeNull()
  })
})
