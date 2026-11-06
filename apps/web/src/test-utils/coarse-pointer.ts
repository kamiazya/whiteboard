import { cdp } from 'vitest/browser'

/**
 * Puts the page on a finger, for a layout test that must render the COARSE
 * row rather than reason about it: Chromium's touch emulation is what makes
 * `(pointer: coarse)` match, so the `pointer-coarse:` classes and
 * `hasCoarsePointer()` both answer the way a phone's do.
 *
 * Only in a `*.window-state.browser.test.tsx` file, which
 * `tools/arch-lint`'s test-fullscreen-isolation scan enforces. Turning the emulation
 * off does NOT give the page its mouse back: measured, `(pointer: fine)` and
 * `(hover: hover)` both read false afterwards, and no CDP call tried
 * (clearing device metrics, turning mouse-to-touch off, emulated media)
 * restores them. The page outlives the file, so in `web-browser` the next
 * file in that page loses every `pointer-fine:` control — the shortcut-help
 * test timed out on its hidden Help button. Still call
 * `emulateCoarsePointer(false)` in `afterEach`, which does end the touch
 * events.
 */
export async function emulateCoarsePointer(on: boolean): Promise<void> {
  await cdp().send('Emulation.setTouchEmulationEnabled', {
    enabled: on,
    maxTouchPoints: on ? 5 : 1,
  })
}
