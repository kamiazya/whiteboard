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

    // The centering/positioning wrapper and the animated surface are
    // separate elements (the enter keyframe owns `transform`), so the
    // fixed+z contract holds on the status element or an ancestor.
    const toast = screen.getByRole('status')
    const overlay = toast.closest('[class*="fixed"]') as HTMLElement | null
    expect(overlay).not.toBeNull()
    expect(overlay?.className).toMatch(/\bfixed\b/)
    expect(overlay?.className).toMatch(/\bz-\d+\b/)
  })

  // Putting it off must not make it unfindable. A user with no reason to care
  // about versions would otherwise dismiss once and run old code forever,
  // which is the failure this notice exists to prevent.
  it('collapses to a persistent chip instead of disappearing', () => {
    const onDismiss = vi.fn()
    render(<UpdateToast onReload={vi.fn()} onDismiss={onDismiss} />)

    fireEvent.click(screen.getByRole('button', { name: 'Later' }))

    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
    expect(screen.getByRole('button', { name: /Update available/i })).toBeTruthy()
  })

  it('reopens from the chip', () => {
    render(<UpdateToast onReload={vi.fn()} onDismiss={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    fireEvent.click(screen.getByRole('button', { name: /Update available/i }))

    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })
})
