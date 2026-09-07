import { useRef } from 'react'

/**
 * The last in-flight frame of a move or resize, held from the drop until the
 * committed scene catches up with it.
 *
 * The committed scene is laid out in a worker for any canvas past
 * `use-worker-scene`'s offload threshold, so the drop's OWN layout arrives one
 * round trip after the commit that asked for it. Retiring the drag layers at
 * the pointerup therefore hands the surface back to a scene that still draws
 * the node where the drag started — and when the new scene lands, the keyed
 * patcher sees that same key in a different place and plays its FLIP. The two
 * together read as the node teleporting back to the grab point and flying to
 * where it was dropped, on every drag, on any canvas big enough to offload.
 *
 * Holding the last frame closes both halves at once: the ghost stays over the
 * drop until the committed surface can draw the node there, and the release is
 * then the layer swap the patcher already declines to animate (`animate:
 * false`, via `useKeyedSvg`'s source token) — an insertion rather than a move.
 *
 * `sceneCurrent` is the release signal rather than a timer because it answers
 * the actual question: whether what is on screen was built from the canvas the
 * drop produced.
 *
 * The ref is written during render for the same reason `useGestureCaptured`
 * writes its own: the hold must be visible to the very render that ends the
 * gesture, and an effect would lag it by a frame — which is the frame the
 * stale scene paints.
 */
export function useDropSettle<T>(inFlight: boolean, live: T, sceneCurrent: boolean): T {
  // Boxed, so a held value that is itself nullish still reads as held.
  const held = useRef<{ readonly value: T } | null>(null)
  if (inFlight) {
    held.current = { value: live }
    return live
  }
  if (held.current !== null && !sceneCurrent) return held.current.value
  held.current = null
  return live
}
