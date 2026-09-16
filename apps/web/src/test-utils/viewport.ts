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
 * blocking window state is somebody else's. Each test file runs in its own
 * iframe, real fullscreen is a property of the WINDOW, and whether the two are
 * in flight together depends on how files were distributed across pages that
 * run. So the victim rotates, every victim passes in isolation and on a re-run
 * of the same commit, and none of them has any reach into fullscreen.
 *
 * `document.fullscreenElement` cannot see it for the same reason — it is null
 * in an iframe that does not own it. The TOP document sees the owner whatever
 * iframe it is (as that `<iframe>` element), and exiting there clears it for
 * the owner too, which is why that is where this asks.
 *
 * ## Why the exit alone was not enough, and what this now measures
 *
 * Exiting at the top document landed first and the flake KEPT HAPPENING —
 * measured on two consecutive full `web-browser` runs, a different victim each
 * time (`WorkspaceTopBar`, then `CommentsRailChrome`), both importing this
 * helper so the exit had run, neither touched by the diff. Two hypotheses
 * survive that, and they want opposite fixes:
 *
 * 1. **The exit addresses one of three states.** The CDP message names
 *    minimized, maximized AND fullscreen. `document.fullscreenElement` is null
 *    for a MAXIMIZED window — that is a window-manager state, not a Fullscreen
 *    API one — so the exit is a no-op while `setWindowBounds` still refuses.
 *    No page-side API can clear it either, so the fix would be elsewhere.
 * 2. **Check-then-act.** Files run in parallel, so another iframe can enter
 *    fullscreen between the exit and the resize. No page-side check can win
 *    that race; a retry can.
 *
 * Picking one without measuring is the mistake, so this does not pick. It
 * makes the next occurrence SAY which, by turning a 60s timeout that names the
 * wrong thing into a bounded failure that names `setWindowBounds` — and by
 * retrying once, which is the discriminator: a resize that succeeds on the
 * retry was blocked transiently (hypothesis 2), and one that fails twice was
 * blocked by a state this helper cannot clear (hypothesis 1). The thrown
 * message says which of those the run just produced.
 */

import { page } from 'vitest/browser'
import { resizeOrExplain } from './viewport-resize.js'

/** The blocking state this helper CAN clear: fullscreen, owned by any iframe. */
async function exitTopFullscreen(): Promise<void> {
  const top = window.parent.document
  if (top.fullscreenElement !== null) await top.exitFullscreen()
}

export async function setViewport(width: number, height: number): Promise<void> {
  await resizeOrExplain(
    () => page.viewport(width, height),
    exitTopFullscreen,
    `page.viewport(${width}, ${height})`,
  )
}
