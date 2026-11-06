import { cdp } from 'vitest/browser'

/**
 * Puts the page on a finger, for a layout test that must render the COARSE
 * row rather than reason about it: Chromium's touch emulation is what makes
 * `(pointer: coarse)` match, so the `pointer-coarse:` classes and
 * `hasCoarsePointer()` both answer the way a phone's do. Pair every call with
 * `emulateCoarsePointer(false)` in `afterEach` — the emulation outlives the
 * test that set it.
 */
export async function emulateCoarsePointer(on: boolean): Promise<void> {
  await cdp().send('Emulation.setTouchEmulationEnabled', {
    enabled: on,
    maxTouchPoints: on ? 5 : 1,
  })
}
