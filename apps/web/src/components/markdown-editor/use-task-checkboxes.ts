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

/** Makes the drawn boxes focusable and names each from its source item. */
function prepareBoxes(host: HTMLElement | null, source: string): Element[] {
  const boxes = Array.from(host?.querySelectorAll(CHECKBOX) ?? [])
  const lines = taskLineNumbers(source)
  boxes.forEach((box, index) => {
    box.setAttribute('tabindex', '0')
    // A rect has no text of its own: its words sit in a sibling <text>.
    const line = lines[index]
    if (boxes.length === lines.length && line !== undefined) {
      box.setAttribute('aria-label', taskItemText(source, line))
    }
  })
  return boxes
}

/** The drawn box under `target` and the source line behind it, if they agree. */
function locateBox(
  host: HTMLElement | null,
  source: string,
  target: EventTarget | null,
): { index: number; line: number } | null {
  const box = target instanceof Element ? target.closest(CHECKBOX) : null
  if (host === null || box === null) return null
  const drawn = Array.from(host.querySelectorAll(CHECKBOX))
  const lines = taskLineNumbers(source)
  const index = drawn.indexOf(box)
  const line = lines[index]
  return drawn.length === lines.length && line !== undefined ? { index, line } : null
}

/**
 * Puts focus back on the box that was toggled. Answers what to announce once
 * the repaint carrying the new state has arrived, and null until then.
 */
function settleToggle(
  boxes: readonly Element[],
  waiting: { index: number; keyed: KeyedSvgRender },
  keyed: KeyedSvgRender,
): string | null {
  const box = boxes[waiting.index]
  if (box instanceof SVGElement && document.activeElement !== box) box.focus()
  if (keyed === waiting.keyed || box === undefined) return null
  const done = box.getAttribute('aria-checked') === 'true'
  return `${box.getAttribute('aria-label') ?? 'Task'}: ${done ? 'checked' : 'not checked'}`
}

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
      const hit = onToggleTask && locateBox(hostRef.current, source, target)
      if (!hit) return false
      pending.current = { index: hit.index, keyed }
      onToggleTask(hit.line)
      return true
    },
    [keyed, onToggleTask, source],
  )
  // Declared after the keyed patcher's layout effect has run for this commit,
  // so the boxes it just painted are the ones made focusable.
  useEffect(() => {
    if (onToggleTask === undefined) return
    const boxes = prepareBoxes(hostRef.current, source)
    const said = pending.current === null ? null : settleToggle(boxes, pending.current, keyed)
    if (said === null) return
    pending.current = null
    setAnnouncement(said)
  }, [keyed, onToggleTask, source])
  return { hostRef, announcement, handlers: onToggleTask ? activationHandlers(toggleFrom) : {} }
}

function activationHandlers(toggleFrom: (target: EventTarget | null) => boolean) {
  return {
    onClick: (event: MouseEvent<HTMLDivElement>) => {
      toggleFrom(event.target)
    },
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if ((event.key === 'Enter' || event.key === ' ') && toggleFrom(event.target)) {
        event.preventDefault()
      }
    },
  }
}
