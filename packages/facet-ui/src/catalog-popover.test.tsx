/**
 * The popover shell, on the path jsdom actually runs.
 *
 * jsdom implements NONE of the Popover API — measured: `showPopover` is
 * `undefined` and `popover` is not even a property — so these cases
 * exercise the fallback: this component owns open/closed, light dismiss and
 * Escape. The native path (top layer, `popovertarget`, the browser's own
 * light dismiss) is what a real browser takes, and
 * `node-symbol-menu.browser.test.tsx` is where it is driven.
 *
 * That split is the point rather than a gap. The fallback is not legacy
 * code kept alive by a test: it is the only path one of the two suites has.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CatalogPopover } from './catalog-popover.js'

afterEach(cleanup)

function mount(onMountContent = () => {}) {
  function Content() {
    onMountContent()
    return <p>the catalog</p>
  }
  render(
    <CatalogPopover label="Choose symbol" current="⭐">
      <Content />
    </CatalogPopover>,
  )
  return screen.getByRole('button', { name: 'Choose symbol' })
}

/**
 * jsdom lays nothing out, so a trigger reports a zero rect and every
 * placement case would be the same one. Standing a trigger at a chosen
 * height is the whole input to `place()`.
 */
function standAt(trigger: HTMLElement, top: number) {
  const rect = {
    top,
    bottom: top + 26,
    left: 300,
    right: 380,
    width: 80,
    height: 26,
    x: 300,
    y: top,
  }
  trigger.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect }) as DOMRect
}

const panel = () => screen.getByRole('dialog', { name: 'Choose symbol' })

describe('a catalog opens over the row rather than inside it', () => {
  /**
   * The whole reason a catalog's rows arrive through `load()` is that a
   * dynamic import is a separate chunk. A panel that mounted its content
   * eagerly would fetch that chunk for every row on screen, and the
   * laziness would be a promise the UI quietly broke.
   */
  it('does not mount what it holds until it is opened', () => {
    const mounted = vi.fn()
    const trigger = mount(mounted)
    expect(mounted).not.toHaveBeenCalled()
    expect(screen.queryByText('the catalog')).toBeNull()

    fireEvent.click(trigger)
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(screen.getByText('the catalog')).toBeTruthy()
  })

  it('says whether it is open, where a reader with no panel in view can hear it', () => {
    const trigger = mount()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('closes on a second press of the trigger', () => {
    const trigger = mount()
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    expect(screen.queryByText('the catalog')).toBeNull()
  })

  it('closes on Escape, so the keyboard is never trapped in it', () => {
    const trigger = mount()
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('the catalog')).toBeNull()
  })

  it('closes when something outside it is pressed', () => {
    const trigger = mount()
    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByText('the catalog')).toBeNull()
  })

  /**
   * The one that a naive outside-press handler gets wrong: picking a symbol
   * is a press INSIDE the panel, and closing on it would make the picker
   * usable exactly once per open.
   */
  it('stays open when something inside it is pressed', () => {
    const trigger = mount()
    fireEvent.click(trigger)
    fireEvent.pointerDown(screen.getByText('the catalog'))
    expect(screen.getByText('the catalog')).toBeTruthy()
  })

  it('draws what is chosen on the trigger, so the row still reads as a value', () => {
    const trigger = mount()
    expect(trigger.textContent).toContain('⭐')
  })
})

/**
 * `position: fixed` neither clips nor grows, and the top layer a native
 * popover sits in is not a scroll container either — so nothing but this
 * placement keeps a catalog on screen. The row it opens from is often the
 * LAST facet in the inspector, which is exactly the case with no room under
 * it: the panel went below the fold with its search box and every cell.
 *
 * jsdom runs the fallback path, and the arithmetic under test is shared —
 * `place()` writes the same four properties whichever path owns opening.
 */
describe('the panel opens somewhere a person can actually see it', () => {
  it('opens downward from a trigger with room under it', () => {
    const trigger = mount()
    standAt(trigger, 40)
    fireEvent.click(trigger)
    expect(panel().style.top).toBe('72px')
    expect(panel().style.bottom).toBe('auto')
  })

  /** The case that motivated it: the last row of a full inspector. */
  it('opens upward from a trigger with nothing under it', () => {
    const trigger = mount()
    standAt(trigger, window.innerHeight - 42)
    fireEvent.click(trigger)
    expect(panel().style.top).toBe('auto')
    expect(panel().style.bottom).toBe('48px')
  })

  /**
   * A height it must not exceed, and a scroller so what it holds is still
   * reachable at that height. Without the second the first would only trade
   * a panel off the bottom of the screen for one cut off at its own edge.
   */
  it('never asks for more height than the viewport has, and scrolls at it', () => {
    const trigger = mount()
    standAt(trigger, 40)
    fireEvent.click(trigger)
    const height = Number.parseFloat(panel().style.maxHeight)
    expect(height).toBeGreaterThan(0)
    expect(height).toBeLessThanOrEqual(window.innerHeight - 16)
    expect(Number.parseFloat(panel().style.top) + height).toBeLessThanOrEqual(window.innerHeight)
    expect(getComputedStyle(panel()).overflowY).toBe('auto')
  })

  /**
   * Written every time rather than cleared, because the UA stylesheet gives
   * `[popover]` `inset: 0`: an unset `top` is `0`, and the over-constrained
   * rule then drops the `bottom` meant to hold the panel above the trigger.
   * jsdom implements no popover and so cannot show that — what it can pin
   * is that neither property is ever left empty for the UA sheet to answer.
   */
  it('states both vertical edges, so no stylesheet gets to answer for it', () => {
    const trigger = mount()
    standAt(trigger, 40)
    fireEvent.click(trigger)
    expect(panel().style.top).not.toBe('')
    expect(panel().style.bottom).not.toBe('')
  })

  it('follows its trigger when the page scrolls under it', () => {
    const trigger = mount()
    standAt(trigger, 40)
    fireEvent.click(trigger)
    expect(panel().style.top).toBe('72px')
    standAt(trigger, 120)
    fireEvent.scroll(document, {})
    expect(panel().style.top).toBe('152px')
  })
})
