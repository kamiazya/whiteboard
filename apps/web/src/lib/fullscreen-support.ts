/**
 * Whether this browser can put an ELEMENT into fullscreen.
 *
 * iPhone Safari cannot: its Fullscreen API is video-only (iPad Safari and
 * every desktop browser do offer the element API), so `Fullscreen` was a
 * button that visibly did nothing on a phone.
 *
 * Detection is by CAPABILITY — does the element actually have a
 * `requestFullscreen` method — not by `document.fullscreenEnabled` alone.
 * That was the first attempt and it shipped the bug it was meant to fix:
 * iPhone Safari does not implement the property at all, so it reads
 * `undefined`, and "only an explicit false means unsupported" let the
 * button through on exactly the device it was hidden for. A runtime that
 * implements the whole API absent (jsdom) also has no method, and hiding
 * there is correct too — no jsdom test asserts the affordance exists.
 *
 * `fullscreenEnabled === false` is still honoured on top: a browser that
 * HAS the method can still refuse (an iframe without the permission), and
 * that answer is authoritative.
 */
export function isFullscreenSupported(doc: Document = document): boolean {
  const root = doc.documentElement as (HTMLElement & { webkitRequestFullscreen?: unknown }) | null
  if (root === null) return false
  const hasMethod =
    typeof root.requestFullscreen === 'function' ||
    typeof root.webkitRequestFullscreen === 'function'
  if (!hasMethod) return false
  return doc.fullscreenEnabled !== false
}
