/**
 * M2 feedback micro-motion contract (real browser, real compiled CSS):
 * state-change feedback surfaces animate on the shared motion tokens.
 *
 * - The update toast enters with a real animation (not an instant pop).
 * - The connection chip transitions its colors on the token duration.
 * - Entering sync-off pulses a finite attention echo on the chip dot —
 *   finite, so the chip guides attention once instead of pinging forever.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ConnectionStatus } from './components/connection/ConnectionStatus.js'
import './index.css'
import { UpdateToast } from './pwa/UpdateToast.js'

beforeAll(async () => {
  await vi.waitFor(() => {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue('--motion-duration-normal')
      .trim()
    if (v === '') throw new Error('index.css not applied yet')
  })
})

afterEach(cleanup)

describe('feedback micro-motion', () => {
  it('update toast enters with an animation on the token duration', () => {
    render(<UpdateToast onReload={vi.fn()} onDismiss={vi.fn()} />)
    const toast = document.querySelector('[role="status"]') as HTMLElement
    const cs = getComputedStyle(toast)
    expect(cs.animationName).not.toBe('none')
    expect(cs.animationDuration).toBe('0.22s')
  })

  it('connection chip transitions colors on the token duration', () => {
    render(<ConnectionStatus state={{ keeper: 'daemon', session: 'synced' }} />)
    const chip = document.querySelector('[data-testid="connection-chip"]') as HTMLElement
    const cs = getComputedStyle(chip)
    expect(cs.transitionProperty).toContain('color')
    expect(cs.transitionDuration).toContain('0.22s')
  })

  it('sync-off shows a finite attention pulse on the chip dot', () => {
    render(
      <ConnectionStatus state={{ keeper: 'daemon', session: 'sync-off' }} onRepair={vi.fn()} />,
    )
    const echo = document.querySelector('[data-testid="connection-chip-pulse"]') as HTMLElement
    expect(echo).not.toBeNull()
    const cs = getComputedStyle(echo)
    expect(cs.animationName).toBe('attention-pulse')
    // Finite: guides attention on entry, never pings forever.
    expect(Number(cs.animationIterationCount)).toBeGreaterThan(0)
    expect(cs.animationIterationCount).not.toBe('infinite')
  })

  it('synced chip has no attention pulse', () => {
    render(<ConnectionStatus state={{ keeper: 'daemon', session: 'synced' }} />)
    expect(document.querySelector('[data-testid="connection-chip-pulse"]')).toBeNull()
  })
})
