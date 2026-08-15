import { useRef } from 'react'

/**
 * The value as it was when `active` became true, held for as long as it stays
 * true.
 *
 * Exists because the committed layout (scene, anchors) arrives ASYNCHRONOUSLY
 * from the layout worker, and a reply can land while a drag gesture is in
 * flight. Anything derived from the committed layout at gesture start — the
 * anchor points bystander edges are pinned to, above all — must not swap
 * mid-gesture: the pin exists precisely so those edges cannot re-fraction
 * while the user's hand is moving. Capturing here, rather than depending on
 * the live value, is what makes the freeze hold.
 *
 * The ref is written during render on purpose: the capture must be visible to
 * the same render that starts the gesture (an effect would lag one frame and
 * hand that first frame the live value). The write is idempotent for a given
 * `active` run, which is what keeps it safe under re-renders.
 */
export function useGestureCaptured<T>(active: boolean, value: T): T {
  const captured = useRef<T | null>(null)
  if (!active) {
    captured.current = null
    return value
  }
  captured.current ??= value
  return captured.current
}
