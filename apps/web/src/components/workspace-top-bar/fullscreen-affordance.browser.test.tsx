/**
 * The Fullscreen affordance hides where the browser has no element
 * fullscreen (iPhone Safari — video-only there), rather than offering a
 * control that visibly does nothing. Real browser: the decision reads
 * `document.fullscreenEnabled`, which jsdom does not implement at all.
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TopBarSecondaryActions } from './TopBarSecondaryActions.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function stubFullscreenEnabled(value: boolean) {
  vi.spyOn(document, 'fullscreenEnabled', 'get').mockReturnValue(value)
  // A browser that answers `false` on the standard property and offers no
  // prefixed one is the iPhone Safari shape.
  Object.defineProperty(document, 'webkitFullscreenEnabled', {
    configurable: true,
    get: () => undefined,
  })
}

it('offers Fullscreen where the browser supports it', () => {
  stubFullscreenEnabled(true)
  const { container } = render(<TopBarSecondaryActions onToggleFullscreen={() => {}} />)
  expect(container.querySelector('[aria-label="Fullscreen"]')).not.toBeNull()
})

// The kebab must be OPENED to assert on its items: a closed DropdownMenu
// renders no content, so checking the document text while it is shut would
// pass no matter what the menu holds. Opened by dispatching pointerDown at
// the trigger (Radix's own open event, the pattern the other top-bar tests
// use) rather than a user click: the trigger is `min-[400px]:hidden`, so at
// the test window's width a real click has nothing visible to land on.
async function openKebab(container: HTMLElement): Promise<void> {
  const trigger = container.querySelector(
    '[data-testid="topbar-more-actions-trigger"]',
  ) as HTMLElement
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull())
}

it('hides Fullscreen — button and kebab item — where the browser has none', async () => {
  stubFullscreenEnabled(false)
  const { container } = render(<TopBarSecondaryActions onToggleFullscreen={() => {}} />)
  expect(container.querySelector('[aria-label="Fullscreen"]')).toBeNull()
  await openKebab(container)
  expect(document.body.textContent).not.toContain('Fullscreen')
})

it('offers the kebab item too where the browser supports it', async () => {
  stubFullscreenEnabled(true)
  const { container } = render(<TopBarSecondaryActions onToggleFullscreen={() => {}} />)
  await openKebab(container)
  expect(document.querySelector('[role="menuitem"]')?.textContent).toContain('Fullscreen')
})

it('hides Fullscreen on the real iPhone shape: no element API at all', async () => {
  // The shape that shipped the first version of this bug. iPhone Safari's
  // Fullscreen API is video-only: documentElement has no
  // requestFullscreen, AND `fullscreenEnabled` is not implemented either
  // — so a check that only rejected an explicit `false` let the button
  // through on exactly the device it was hidden for.
  const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: unknown }
  const original = Object.getOwnPropertyDescriptor(Element.prototype, 'requestFullscreen')
  Object.defineProperty(root, 'requestFullscreen', { configurable: true, value: undefined })
  Object.defineProperty(root, 'webkitRequestFullscreen', { configurable: true, value: undefined })
  try {
    const { container } = render(<TopBarSecondaryActions onToggleFullscreen={() => {}} />)
    expect(container.querySelector('[aria-label="Fullscreen"]')).toBeNull()
    await openKebab(container)
    expect(document.body.textContent).not.toContain('Fullscreen')
  } finally {
    delete (root as { requestFullscreen?: unknown }).requestFullscreen
    delete (root as { webkitRequestFullscreen?: unknown }).webkitRequestFullscreen
    expect(original).toBeDefined()
  }
})
