import { page } from 'vitest/browser'

/**
 * `page.viewport`, with the precondition Chromium imposes on it.
 *
 * A resize goes through CDP `Browser.setWindowBounds`, which refuses a window
 * that is not in its normal state: *"To resize minimized/maximized/fullscreen
 * window, restore it to normal state first."* Vitest never delivers that
 * rejection to the caller — the `await` simply does not settle — so the test
 * spends its entire 60s budget and reports `Test timed out in 60000ms`. That
 * message names the test that asked for the resize and says nothing about the
 * state that refused it; the real reason arrives separately, as an
 * "Unhandled Rejection" attributed to no test at all. It reads like a slow
 * test, and the line it points at is fine.
 *
 * What makes it a flake rather than a bug in the file that trips it: the
 * fullscreen is somebody else's. Each test file runs in its own iframe, real
 * fullscreen is a property of the WINDOW, and whether the two are in flight
 * together depends on how files were distributed across pages that run. So
 * the victim rotates, every victim passes in isolation and on a re-run of the
 * same commit, and none of them has any reach into fullscreen.
 *
 * `document.fullscreenElement` cannot see it for the same reason — it is null
 * in an iframe that does not own it. The TOP document sees the owner whatever
 * iframe it is (as that `<iframe>` element), and exiting there clears it for
 * the owner too, which is why that is where this asks.
 */
export async function setViewport(width: number, height: number): Promise<void> {
  const top = window.parent.document
  if (top.fullscreenElement !== null) await top.exitFullscreen()
  await page.viewport(width, height)
}
