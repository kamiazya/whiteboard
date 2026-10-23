import type { KeyedSvgRender } from '@kamiazya/whiteboard-canvas-render'
import {
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { taskItemText, taskLineNumbers } from '../../lib/task-toggle.js'

const CHECKBOX = '[role="checkbox"]'

/**
 * Makes the task checkboxes the preview drew into `hostRef` operable: a click
 * or Enter/Space on one reports the source line of its item.
 *
 * The i-th drawn box is the i-th task line of `source`. The counts must agree
 * or the activation is dropped: a box with no line behind it (an embedded
 * note's) would otherwise toggle somebody else's.
 */
export function useTaskCheckboxes(
  source: string,
  keyed: KeyedSvgRender,
  onToggleTask: ((line: number) => void) | undefined,
): {
  hostRef: MutableRefObject<HTMLDivElement | null>
  /** What a screen reader should hear after the last toggle; empty before one. */
  announcement: string
  handlers: {
    onClick?: (event: MouseEvent<HTMLDivElement>) => void
    onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  }
} {
  const hostRef = useRef<HTMLDivElement | null>(null)
  // A toggle repaints the preview, which replaces the box that held focus, so
  // the box is found again by its position once the repaint arrives.
  const pending = useRef<{ index: number; keyed: KeyedSvgRender } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const toggleFrom = useCallback(
    (target: EventTarget | null): boolean => {
      const host = hostRef.current
      const box = target instanceof Element ? target.closest(CHECKBOX) : null
      if (host === null || box === null || onToggleTask === undefined) return false
      const drawn = Array.from(host.querySelectorAll(CHECKBOX))
      const lines = taskLineNumbers(source)
      const line = lines[drawn.indexOf(box)]
      if (drawn.length !== lines.length || line === undefined) return false
      pending.current = { index: drawn.indexOf(box), keyed }
      onToggleTask(line)
      return true
    },
    [keyed, onToggleTask, source],
  )
  // Declared after the keyed patcher's layout effect has run for this commit,
  // so the boxes it just painted are the ones made focusable.
  useEffect(() => {
    if (onToggleTask === undefined) return
    const boxes = Array.from(hostRef.current?.querySelectorAll(CHECKBOX) ?? [])
    const lines = taskLineNumbers(source)
    boxes.forEach((box, index) => {
      box.setAttribute('tabindex', '0')
      // A rect has no text of its own: its words sit in a sibling <text>.
      const line = lines[index]
      if (boxes.length === lines.length && line !== undefined) {
        box.setAttribute('aria-label', taskItemText(source, line))
      }
    })
    const waiting = pending.current
    if (waiting === null) return
    const box = boxes[waiting.index]
    if (box instanceof SVGElement && document.activeElement !== box) box.focus()
    if (keyed === waiting.keyed || box === undefined) return
    pending.current = null
    const done = box.getAttribute('aria-checked') === 'true'
    setAnnouncement(
      `${box.getAttribute('aria-label') ?? 'Task'}: ${done ? 'checked' : 'not checked'}`,
    )
  }, [keyed, onToggleTask, source])
  if (onToggleTask === undefined) return { hostRef, announcement, handlers: {} }
  return {
    hostRef,
    announcement,
    handlers: {
      onClick: (event) => {
        toggleFrom(event.target)
      },
      onKeyDown: (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && toggleFrom(event.target)) {
          event.preventDefault()
        }
      },
    },
  }
}
