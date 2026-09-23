import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react'
import { useRef } from 'react'

/** The split's bounds, so neither pane can vanish, and the arrow-key step. */
const MIN_SPLIT_RATIO = 0.2
const MAX_SPLIT_RATIO = 0.8
const KEYBOARD_SPLIT_STEP = 0.05

/**
 * Resizing the split, as one thing.
 *
 * The pointer gesture, the keyboard step and the clamp that keeps either
 * pane from vanishing were four handlers and a helper sitting among thirty
 * other locals in the editor, tied together by nothing but the prefix on
 * their names.
 */
export function useSplitDrag(
  rootRef: RefObject<HTMLDivElement | null>,
  setSplitRatio: (next: number | ((current: number) => number)) => void,
) {
  const clampRatio = (ratio: number) => Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio))

  const draggingRef = useRef(false)
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    draggingRef.current = true
    // Capture keeps the drag alive when the pointer outruns the divider;
    // a synthetic test event has no active pointer to capture, so a
    // capture failure must not abort the drag itself.
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // draggingRef alone still tracks the gesture
    }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    const root = rootRef.current
    if (!root) return
    const bounds = root.getBoundingClientRect()
    if (bounds.width <= 0) return
    setSplitRatio(clampRatio((event.clientX - bounds.left) / bounds.width))
  }
  const onPointerUp = () => {
    draggingRef.current = false
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const delta = event.key === 'ArrowLeft' ? -KEYBOARD_SPLIT_STEP : KEYBOARD_SPLIT_STEP
    setSplitRatio((current) => clampRatio(current + delta))
  }
  return { onPointerDown, onPointerMove, onPointerUp, onKeyDown }
}

/** The ARIA window-splitter between the two columns. */
export function SplitDivider({
  ratio,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onKeyDown,
}: { ratio: number } & ReturnType<typeof useSplitDrag>) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: this is the ARIA window-splitter pattern (focusable, arrow-key operable separator); an <hr> cannot take focus or a value
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize editor and preview"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={MIN_SPLIT_RATIO * 100}
      aria-valuemax={MAX_SPLIT_RATIO * 100}
      tabIndex={0}
      data-testid="markdown-split-divider"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      className="bg-border hover:bg-ring focus-visible:bg-ring w-1 shrink-0 cursor-col-resize touch-none transition-colors duration-(--motion-duration-fast) focus-visible:outline-none"
    />
  )
}
