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
