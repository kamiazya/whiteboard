// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SaveIndicator } from '../../lib/save-indicator.js'
import { SAVING_SHOWN_AFTER_MS, SaveStatus } from './SaveStatus.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const saved: SaveIndicator = { tone: 'saved', label: 'Saved' }
const saving: SaveIndicator = { tone: 'saving', label: 'Saving…' }
const storage: SaveIndicator = { tone: 'problem', label: 'Not saved — storage problem' }

const region = () => screen.getByRole('status')
const visible = () => screen.getByTestId('save-status')

describe('SaveStatus', () => {
  it('shows Saved quietly and announces nothing', () => {
    render(<SaveStatus indicator={saved} />)
    expect(visible().textContent).toContain('Saved')
    expect(region().textContent).toBe('')
  })

  it('keeps the live region mounted and fills it only on a problem', () => {
    const { rerender } = render(<SaveStatus indicator={saved} />)
    const mounted = region()
    rerender(<SaveStatus indicator={storage} />)
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

  it('shows a problem at once', () => {
    render(<SaveStatus indicator={storage} />)
    expect(visible().textContent).toContain('Not saved — storage problem')
    expect(visible().getAttribute('data-tone')).toBe('problem')
  })
})
