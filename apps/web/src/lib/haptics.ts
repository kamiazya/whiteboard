/**
 * A single short haptic tick, for moments where the platform's native
 * gesture would have given one (the long-press that opens the canvas
 * context menu — its native ancestor, the iOS callout, ticked).
 *
 * Feedback only, by contract: every path is best-effort and swallows its
 * own failures — an action must never break because its haptic could not
 * fire.
 *
 * Platform reality:
 * - Android/desktop Chromium: the Vibration API.
 * - iOS Safari: no Vibration API on any version. Since 17.4, toggling a
 *   switch-styled checkbox produces the system'switch' haptic, and a
 *   programmatic label click triggers it — the only web-reachable haptic
 *   on iOS today. It is a documented-behavior side effect, not a haptics
 *   API; if Apple closes it, this silently becomes a no-op, which is the
 *   correct failure mode for feedback.
 */

let switchLabel: HTMLLabelElement | null = null

function iosSwitchTick(): void {
  if (switchLabel === null || !switchLabel.isConnected) {
    const label = document.createElement('label')
    // Visually and semantically inert: never focusable, never announced,
    // never hit-testable.
    label.setAttribute('aria-hidden', 'true')
    label.style.cssText =
      'position:fixed;top:0;left:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.setAttribute('switch', '')
    input.tabIndex = -1
    label.appendChild(input)
    document.body.appendChild(label)
    switchLabel = label
  }
  switchLabel.click()
}

export function hapticTick(): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(10)
      return
    }
    iosSwitchTick()
  } catch {
    // feedback only — see module doc
  }
}
