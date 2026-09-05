/**
 * M2 feedback micro-motion contract (real browser, real compiled CSS):
 * state-change feedback surfaces animate on the shared motion tokens.
 *
 * - The update toast enters with a real animation (not an instant pop).
 * - The connection chip transitions its colors on the token duration.
 * - Entering sync-off pulses a finite attention echo on the chip dot —
 *   finite, so the chip guides attention once instead of pinging forever.
 * - A document thumbnail's render fades in when it finally lands, measured
 *   on a real switch at 430ms after its own card, so it develops instead of
 *   popping.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ConnectionStatus } from './components/connection/ConnectionStatus.js'
import { DocumentThumbnail } from './components/workspace-files/DocumentThumbnail.js'
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

  it('a thumbnail CROSS-fades: the icon leaves as the render arrives', async () => {
    // Measured on the real app before this existed: the icon unmounted in
    // the same frame the render mounted at opacity 0, so the box was empty
    // for a frame — 1913ms icon=1.00, 1929ms icon gone / render=0.00. Both
    // halves must be on screen together, and the icon must be LEAVING.
    render(
      <DocumentThumbnail
        document={{ documentId: 'd2', path: 'note-2', kind: 'markdown' }}
        loadRender={async () => ({
          svg: '<svg viewBox="0 0 10 10"></svg>',
          bounds: { x: 0, y: 0, w: 10, h: 10 },
        })}
      />,
    )
    const box = await vi.waitFor(() => {
      const el = document.querySelector('[data-testid="document-thumbnail"]')
      if (el?.querySelector(':scope > span') == null) throw new Error('render not drawn yet')
      return el as HTMLElement
    })
    const icon = box.querySelector(':scope > svg') as SVGElement | null
    expect(icon).not.toBeNull()
    // The signal a render landed is the ABSENCE of data-kind; the leaving
    // copy must not restore it.
    expect(icon?.getAttribute('data-kind')).toBeNull()
    const leaving = getComputedStyle(icon as unknown as Element)
    expect(leaving.animationName).not.toBe('none')
    expect(leaving.animationDuration).toBe('0.22s')
    // Linear on both halves: the shared ease-out is built for movement and
    // front-loads opacity — measured at 0.80 in 51ms of its 220ms, which is
    // what read as a pop. A dissolve wants the two to trade evenly.
    expect(leaving.animationTimingFunction).toBe('linear')
    const arriving = getComputedStyle(box.querySelector(':scope > span') as Element)
    expect(arriving.animationTimingFunction).toBe('linear')
  })

  it('a thumbnail fades its render in on the token duration', async () => {
    // The class has to resolve to a REAL animation, not merely be present:
    // a mistyped motion token renders a className nobody notices.
    render(
      <DocumentThumbnail
        document={{ documentId: 'd1', path: 'note', kind: 'markdown' }}
        loadRender={async () => ({
          svg: '<svg viewBox="0 0 10 10"></svg>',
          bounds: { x: 0, y: 0, w: 10, h: 10 },
        })}
      />,
    )
    const drawn = await vi.waitFor(() => {
      const el = document.querySelector('[data-testid="document-thumbnail"] > span')
      if (el === null) throw new Error('render not drawn yet')
      return el as HTMLElement
    })
    const cs = getComputedStyle(drawn)
    expect(cs.animationName).not.toBe('none')
    expect(cs.animationDuration).toBe('0.22s')
  })

  it('the shell mark transitions colors on the token duration', () => {
    render(<ConnectionStatus state={{ keeper: 'daemon', session: 'synced' }} />)
    const chip = document.querySelector('[data-testid="shell-mark-trigger"]') as HTMLElement
    const cs = getComputedStyle(chip)
    expect(cs.transitionProperty).toContain('color')
    expect(cs.transitionDuration).toContain('0.22s')
  })

  it('sync-off shows a finite attention pulse on the mark', () => {
    render(
      <ConnectionStatus state={{ keeper: 'daemon', session: 'sync-off' }} onRepair={vi.fn()} />,
    )
    const echo = document.querySelector('[data-testid="shell-mark-pulse"]') as HTMLElement
    expect(echo).not.toBeNull()
    const cs = getComputedStyle(echo)
    expect(cs.animationName).toBe('attention-pulse')
    // Finite: guides attention on entry, never pings forever.
    expect(Number(cs.animationIterationCount)).toBeGreaterThan(0)
    expect(cs.animationIterationCount).not.toBe('infinite')
  })

  it('a synced mark has no attention pulse', () => {
    render(<ConnectionStatus state={{ keeper: 'daemon', session: 'synced' }} />)
    expect(document.querySelector('[data-testid="shell-mark-pulse"]')).toBeNull()
  })

  it("reconnecting travels rather than pulsing, since it shares sync-off's tone", () => {
    // The two amber states are told apart by motion, not colour. Pinned here
    // because it is a COMPUTED-style claim: the class has to resolve to a
    // real running animation, not merely be present in the markup.
    render(<ConnectionStatus state={{ keeper: 'daemon', session: 'reconnecting' }} />)
    expect(document.querySelector('[data-testid="shell-mark-pulse"]')).toBeNull()
    const stroke = document.querySelector('[data-testid="shell-mark-stroke"]') as SVGPathElement
    const cs = getComputedStyle(stroke)
    expect(cs.animationName).toBe('wb-loader')
    expect(cs.animationIterationCount).toBe('infinite')
  })
})
