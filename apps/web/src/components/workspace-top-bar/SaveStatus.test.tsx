// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SaveIndicator } from '../../lib/save-indicator.js'
import { PROBLEM_SHOWN_AFTER_MS, SAVING_SHOWN_AFTER_MS, SaveStatus } from './SaveStatus.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const saved: SaveIndicator = { tone: 'saved', label: 'Saved' }
const saving: SaveIndicator = { tone: 'saving', label: 'Saving…' }
const storage: SaveIndicator = { tone: 'problem', label: 'Not saved — storage problem' }
const offline: SaveIndicator = { tone: 'problem', label: 'Offline — changes kept here' }

const region = () => screen.getByRole('status')
const visible = () => screen.getByTestId('save-status')

describe('SaveStatus', () => {
  it('shows Saved quietly and announces nothing', () => {
    render(<SaveStatus indicator={saved} />)
    expect(visible().textContent).toContain('Saved')
    expect(region().textContent).toBe('')
  })

  // A bare check below sm read as a confirm button. Saved and Saving are short
  // enough to stay in the row; a problem keeps its head word visible and the
  // full explanation for sm and up and for assistive tech.
  it('keeps a visible word beside the icon at every width', () => {
    const { unmount } = render(<SaveStatus indicator={saved} />)
    expect(visible().querySelector('[data-testid="save-status-word"]')?.className).not.toContain(
      'sr-only',
    )
    unmount()

    render(<SaveStatus indicator={offline} />)
    const phoneWord = visible().querySelector('[data-testid="save-status-short"]')
    expect(phoneWord?.textContent).toBe('Offline')
    expect(phoneWord?.className).toContain('sm:hidden')
  })

  it('keeps the live region mounted and fills it only on a problem', () => {
    vi.useFakeTimers()
    const { rerender } = render(<SaveStatus indicator={saved} />)
    const mounted = region()
    rerender(<SaveStatus indicator={storage} />)
    act(() => {
      vi.advanceTimersByTime(PROBLEM_SHOWN_AFTER_MS)
    })
    expect(region()).toBe(mounted)
    expect(region().textContent).toBe('Not saved — storage problem')
    rerender(<SaveStatus indicator={saved} />)
    expect(region().textContent).toBe('')
  })

  it('does not announce an ordinary save cycle', () => {
    const { rerender } = render(<SaveStatus indicator={saved} />)
    rerender(<SaveStatus indicator={saving} />)
    expect(region().textContent).toBe('')
  })

  it('holds Saved on screen until a write has been pending for a while', () => {
    vi.useFakeTimers()
    const { rerender } = render(<SaveStatus indicator={saved} />)
    rerender(<SaveStatus indicator={saving} />)
    expect(visible().textContent).toContain('Saved')
    act(() => {
      vi.advanceTimersByTime(SAVING_SHOWN_AFTER_MS)
    })
    expect(visible().textContent).toContain('Saving…')
    rerender(<SaveStatus indicator={saved} />)
    expect(visible().textContent).toContain('Saved')
  })

  it('shows a problem the page opens on at once', () => {
    render(<SaveStatus indicator={storage} />)
    expect(visible().textContent).toContain('Not saved — storage problem')
    expect(visible().getAttribute('data-tone')).toBe('problem')
    expect(region().textContent).toBe('Not saved — storage problem')
  })

  // A refusal that resolves itself is nothing a person can act on, and a
  // live region cannot take an announcement back.
  it('neither shows nor announces a problem that clears within the grace', () => {
    vi.useFakeTimers()
    const { rerender } = render(<SaveStatus indicator={saved} />)
    rerender(<SaveStatus indicator={storage} />)
    act(() => {
      vi.advanceTimersByTime(PROBLEM_SHOWN_AFTER_MS / 2)
    })
    expect(visible().getAttribute('data-tone')).toBe('saved')
    expect(region().textContent).toBe('')
    rerender(<SaveStatus indicator={saved} />)
    act(() => {
      vi.advanceTimersByTime(PROBLEM_SHOWN_AFTER_MS * 2)
    })
    expect(visible().getAttribute('data-tone')).toBe('saved')
    expect(region().textContent).toBe('')
  })

  it('shows and announces a problem once it has lasted the grace, and clears at once', () => {
    vi.useFakeTimers()
    const { rerender } = render(<SaveStatus indicator={saved} />)
    rerender(<SaveStatus indicator={storage} />)
    act(() => {
      vi.advanceTimersByTime(PROBLEM_SHOWN_AFTER_MS)
    })
    expect(visible().getAttribute('data-tone')).toBe('problem')
    expect(region().textContent).toBe('Not saved — storage problem')
    rerender(<SaveStatus indicator={saved} />)
    expect(visible().getAttribute('data-tone')).toBe('saved')
    expect(region().textContent).toBe('')
  })

  it('moves from one problem to another without waiting again', () => {
    vi.useFakeTimers()
    const { rerender } = render(<SaveStatus indicator={saved} />)
    rerender(<SaveStatus indicator={offline} />)
    act(() => {
      vi.advanceTimersByTime(PROBLEM_SHOWN_AFTER_MS)
    })
    rerender(<SaveStatus indicator={storage} />)
    expect(visible().textContent).toContain('Not saved — storage problem')
    expect(region().textContent).toBe('Not saved — storage problem')
  })
})
