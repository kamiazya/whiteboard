/**
 * A synthetic finger tap on an element, for browser-mode tests.
 *
 * A `TouchEvent` built this way synthesizes NO mouse events, which is the
 * point: upstream CodeMirror accepts a completion on the synthesized
 * mousedown, so a test that fires one cannot tell a deterministic touch
 * path from the platform's own compatibility events — and it is exactly
 * that ordering a real phone was observed losing.
 *
 * `travel` moves the finger between touchstart and touchend, which is how a
 * caller says the gesture was a scroll rather than a tap.
 */
export function tapElement(el: HTMLElement, identifier: number, travel = 0): void {
  const rect = el.getBoundingClientRect()
  const at = (type: 'touchstart' | 'touchend', y: number) =>
    new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      changedTouches: [new Touch({ identifier, target: el, clientX: rect.x + 4, clientY: y })],
    })
  el.dispatchEvent(at('touchstart', rect.y + 4))
  el.dispatchEvent(at('touchend', rect.y + 4 + travel))
}
