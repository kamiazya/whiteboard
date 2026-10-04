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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
function standAt(trigger: HTMLElement, top: number, right = 380) {
  const left = right - 80
  const rect = {
    top,
    bottom: top + 26,
    left,
    right,
    width: 80,
    height: 26,
    x: left,
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

/**
 * The viewport is the other half of `place()`'s input. jsdom answers a fixed
 * 1024x768, so every case states the size it reasons about rather than
 * leaning on that default, and puts the window's own back afterwards.
 */
describe('the panel keeps its width and its height usable at any viewport', () => {
  const restore: Array<() => void> = []
  function viewport(width: number, height: number) {
    for (const [key, value] of [
      ['innerWidth', width],
      ['innerHeight', height],
    ] as const) {
      const own = Object.getOwnPropertyDescriptor(window, key)
      Object.defineProperty(window, key, { configurable: true, value })
      restore.push(() => {
        if (own === undefined) Reflect.deleteProperty(window, key)
        else Object.defineProperty(window, key, own)
      })
    }
  }
  beforeEach(() => viewport(1024, 768))
  afterEach(() => {
    for (const undo of restore.splice(0).reverse()) undo()
  })

  function openAt(top: number, right: number) {
    const trigger = mount()
    standAt(trigger, top, right)
    fireEvent.click(trigger)
    return panel()
  }

  it('is 320px wide and right-aligned to a trigger in the middle of the page', () => {
    const placed = openAt(40, 680)
    expect(placed.style.width).toBe('320px')
    expect(placed.style.left).toBe('360px')
  })

  it('keeps 8px from the left edge when the trigger is at the far left', () => {
    expect(openAt(40, 80).style.left).toBe('8px')
  })

  it('keeps 8px from the right edge when the trigger is at the far right', () => {
    // 1024 - 320 - 8: the panel's right edge sits 8px inside the viewport.
    expect(openAt(40, 1024).style.left).toBe('696px')
  })

  it('narrows to the viewport less 8px each side on a phone', () => {
    viewport(300, 768)
    const placed = openAt(40, 280)
    expect(placed.style.width).toBe('284px')
    expect(placed.style.left).toBe('8px')
  })

  it('stays below when the room under it is enough, though there is more above', () => {
    // Below: 768 - 494 - 6 - 8 = 260, at least the 240 floor. Above is 454,
    // which is larger, and larger alone is no reason to flip.
    const placed = openAt(468, 680)
    expect(placed.style.top).toBe('500px')
    expect(placed.style.bottom).toBe('auto')
    expect(placed.style.maxHeight).toBe('260px')
  })

  it('takes the room above as its height when it flips up', () => {
    // Below: 768 - 626 - 14 = 128. Above: 600 - 14 = 586.
    const placed = openAt(600, 680)
    expect(placed.style.top).toBe('auto')
    expect(placed.style.maxHeight).toBe('586px')
  })

  it('floors the height at 240px when neither side has that much room', () => {
    // Below: 300 - 156 - 14 = 130. Above: 130 - 14 = 116. Neither side is
    // usable, so the floor answers and the panel scrolls.
    viewport(1024, 300)
    expect(openAt(130, 680).style.maxHeight).toBe('240px')
  })
})
