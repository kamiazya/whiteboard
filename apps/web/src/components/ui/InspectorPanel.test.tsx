// @vitest-environment jsdom
/**
 * The pane's half of the presence contract, where an animation API exists,
 * and the sheet's stage toggle.
 *
 * jsdom has no `getAnimations`, which sends the pane down the let-go-at-once
 * branch (`DocumentPageShell.aside.test.tsx` covers that one). These cases
 * supply the API and drive the frame by hand, so "after a frame" is a step
 * the test takes rather than a wait. The real exit motion is
 * `InspectorPanel.motion.browser.test.tsx`'s.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type InspectorPresence,
  InspectorPresenceContext,
} from '../../contexts/inspector-presence.js'
import { currentOccluders } from '../../lib/spatial/viewport-insets.js'
import { InspectorPanel } from './InspectorPanel.js'

const frames = new Map<number, FrameRequestCallback>()

beforeEach(() => {
  frames.clear()
  let next = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = next++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // `getAnimations` is absent from jsdom's prototype; a stub left behind
  // would move every later file onto this branch.
  Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations')
})

function runFrames(): void {
  const pending = [...frames.values()]
  frames.clear()
  for (const callback of pending) callback(0)
}

function animationsRunning(count: number): void {
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
    configurable: true,
    value: () => Array.from({ length: count }, () => ({}) as Animation),
  })
}

/**
 * React picks the `animationend` spelling it listens for at load, from the
 * DOM it finds: jsdom has no `AnimationEvent` but does carry
 * `WebkitAnimation` on a style, so React subscribes to the prefixed name and
 * an unprefixed event reaches no handler.
 */
function animationEnd(target: Element): void {
  fireEvent(target, new Event('webkitAnimationEnd', { bubbles: true }))
}

function renderPane(presence: InspectorPresence) {
  return render(
    <InspectorPresenceContext.Provider value={presence}>
      <InspectorPanel kind="history" onClose={vi.fn()}>
        <p data-testid="pane-child">versions</p>
      </InspectorPanel>
    </InspectorPresenceContext.Provider>,
  )
}

function closing(onLeft: () => void): InspectorPresence {
  return { state: 'closed', slotWasOccupied: false, onLeft }
}

describe('InspectorPanel leaving where animations exist', () => {
  it('lets go after a frame when no exit animation registered', () => {
    animationsRunning(0)
    const onLeft = vi.fn()
    renderPane(closing(onLeft))
    expect(onLeft).not.toHaveBeenCalled()
    runFrames()
    expect(onLeft).toHaveBeenCalledOnce()
  })

  it('holds on while an exit animation runs, and lets go when its own ends', () => {
    animationsRunning(1)
    const onLeft = vi.fn()
    renderPane(closing(onLeft))
    runFrames()
    expect(onLeft).not.toHaveBeenCalled()
    // A child's animation bubbles here too; only the pane's own ends it.
    animationEnd(screen.getByTestId('pane-child'))
    expect(onLeft).not.toHaveBeenCalled()
    animationEnd(screen.getByTestId('history-panel'))
    expect(onLeft).toHaveBeenCalledOnce()
  })

  it('ignores an animation ending while the pane is open', () => {
    animationsRunning(1)
    const onLeft = vi.fn()
    renderPane({ state: 'open', slotWasOccupied: false, onLeft })
    runFrames()
    animationEnd(screen.getByTestId('history-panel'))
    expect(onLeft).not.toHaveBeenCalled()
  })

  it('drops the pending frame when it unmounts before the frame runs', () => {
    animationsRunning(0)
    const onLeft = vi.fn()
    const { unmount } = renderPane(closing(onLeft))
    unmount()
    runFrames()
    expect(onLeft).not.toHaveBeenCalled()
  })
})

describe('InspectorPanel sheet stage', () => {
  it('expands to the full stage and collapses back to the peek', () => {
    renderPane({ state: 'open', slotWasOccupied: false, onLeft: vi.fn() })
    const pane = screen.getByTestId('history-panel')
    expect(pane.dataset.stage).toBe('peek')
    fireEvent.click(screen.getByRole('button', { name: 'Expand history' }))
    expect(pane.dataset.stage).toBe('full')
    const toggle = screen.getByRole('button', { name: 'Collapse history' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(pane.dataset.stage).toBe('peek')
  })
})

describe('as a surface over the canvas', () => {
  it('registers its element for the editor to measure while it is mounted', () => {
    const { unmount } = render(
      <InspectorPanel kind="display" onClose={() => {}}>
        body
      </InspectorPanel>,
    )
    expect(currentOccluders()).toContain(screen.getByTestId('display-panel'))
    unmount()
    expect(currentOccluders()).toHaveLength(0)
  })
})
