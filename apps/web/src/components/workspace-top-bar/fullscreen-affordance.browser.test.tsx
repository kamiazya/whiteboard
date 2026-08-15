/**
 * The Fullscreen affordance hides where the browser has no element
 * fullscreen (iPhone Safari — video-only there), rather than offering a
 * control that visibly does nothing. Real browser: the decision reads
 * `document.fullscreenEnabled`, which jsdom does not implement at all.
 */
import { cleanup, render } from '@testing-library/react'
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

it('hides Fullscreen — button and kebab item — where the browser has none', () => {
  stubFullscreenEnabled(false)
  const { container } = render(<TopBarSecondaryActions onToggleFullscreen={() => {}} />)
  expect(container.querySelector('[aria-label="Fullscreen"]')).toBeNull()
  expect(container.textContent).not.toContain('Fullscreen')
})
