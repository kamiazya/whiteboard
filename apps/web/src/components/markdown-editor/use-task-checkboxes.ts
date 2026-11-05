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
import { hasCoarsePointer } from '../../lib/platform.js'
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

/** Half of the 44px a coarse pointer is owed around a box drawn at ~13px. */
const COARSE_REACH_PX = 22

/** Where the words drawn on a box's line end: the box itself when it has none. */
function lineRight(host: HTMLElement, box: DOMRect): number {
  let right = box.right
  for (const text of host.querySelectorAll('text')) {
    const rect = text.getBoundingClientRect()
    if (rect.left >= box.left && rect.top < box.bottom && rect.bottom > box.top) {
      right = Math.max(right, rect.right)
    }
  }
  return right
}

/**
 * The box a press beside one was meant for: the nearest box on the press's
 * line, when the press is on that box or on the item's own words to its
 * right — the box is drawn where a bullet would go. A drawn box is ~13px,
 * and a finger needs more: a coarse press reaches a box 22px away, the rest
 * half a line. A press on a link is the link's, and one in the empty space
 * past the words is nobody's.
 */
function boxBeside(host: HTMLElement, target: Element, x: number, y: number): Element | null {
  if (target.closest('a') !== null) return null
  const reach = hasCoarsePointer() ? COARSE_REACH_PX : 0
  let best: { box: Element; dy: number } | null = null
  for (const box of host.querySelectorAll(CHECKBOX)) {
    const rect = box.getBoundingClientRect()
    const dy = Math.abs(y - (rect.top + rect.height / 2))
    const sideways =
      x >= rect.left - Math.max(reach - rect.width / 2, 0) && x <= lineRight(host, rect) + reach
    if (sideways && dy <= Math.max(reach, rect.height) && (best === null || dy < best.dy)) {
      best = { box, dy }
    }
  }
  return best?.box ?? null
}

/**
 * Whether a click is a plain press: a single click with nothing selected.
 * The words beside a box are also text a reader selects — a drag across
 * them ends in a click, and a double-click to pick a word is two — so only
 * a press like that reaches a box through its words. A hit on the box
 * itself needs no such test.
 */
function plainPress(event: MouseEvent<HTMLDivElement>): boolean {
  return event.detail === 1 && (window.getSelection()?.isCollapsed ?? true)
}

/** The drawn box under or beside a press, and the source line behind it, if they agree. */
function locateBox(
  host: HTMLElement | null,
  source: string,
  target: EventTarget | null,
  at?: { readonly x: number; readonly y: number },
): { index: number; line: number } | null {
  if (host === null || !(target instanceof Element)) return null
  const box =
    target.closest(CHECKBOX) ?? (at === undefined ? null : boxBeside(host, target, at.x, at.y))
  if (box === null) return null
  const drawn = Array.from(host.querySelectorAll(CHECKBOX))
  const lines = taskLineNumbers(source)
  const index = drawn.indexOf(box)
  const line = lines[index]
  return drawn.length === lines.length && line !== undefined ? { index, line } : null
}

/** A toggle sent and not yet drawn: which box, and the state it was drawn in. */
interface PendingToggle {
  readonly index: number
  readonly wasChecked: boolean
}

const isChecked = (box: Element | undefined) => box?.getAttribute('aria-checked') === 'true'

/**
 * Puts focus back on the box that was toggled — every repaint replaces it,
 * and a repaint can come before the one carrying the toggle (the page's
 * reference seams follow the body at once while the preview's text waits out
 * its debounce). Answers what to announce once a repaint draws the box in
 * the OTHER state, and null until then, so the old state is never read out.
 */
function settleToggle(boxes: readonly Element[], waiting: PendingToggle): string | null {
  const box = boxes[waiting.index]
  if (box instanceof SVGElement && document.activeElement !== box) box.focus()
  if (box === undefined || isChecked(box) === waiting.wasChecked) return null
  return `${box.getAttribute('aria-label') ?? 'Task'}: ${isChecked(box) ? 'checked' : 'not checked'}`
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
  /** Answers whether the line was rewritten; a press it drops is not waited on. */
  onToggleTask: ((line: number) => boolean) | undefined,
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
  const pending = useRef<PendingToggle | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const toggleFrom = useCallback(
    (target: EventTarget | null, at?: { readonly x: number; readonly y: number }): boolean => {
      const hit = onToggleTask && locateBox(hostRef.current, source, target, at)
      if (!hit) return false
      const drawn = hostRef.current?.querySelectorAll(CHECKBOX)[hit.index]
      const wasChecked = isChecked(drawn)
      if (onToggleTask(hit.line)) pending.current = { index: hit.index, wasChecked }
      return true
    },
    [onToggleTask, source],
  )
  // A key or press outside the preview means the reader has moved on: the
  // box no longer gets focus back. Focus alone cannot tell — writing the
  // toggle through the source view moves focus there itself.
  useEffect(() => {
    const movedOn = (event: Event) => {
      if (event.target instanceof Node && hostRef.current?.contains(event.target)) return
      pending.current = null
    }
    document.addEventListener('keydown', movedOn, true)
    document.addEventListener('pointerdown', movedOn, true)
    return () => {
      document.removeEventListener('keydown', movedOn, true)
      document.removeEventListener('pointerdown', movedOn, true)
    }
  }, [])
  // Declared after the keyed patcher's layout effect has run for this commit,
  // so the boxes it just painted are the ones made focusable.
  useEffect(() => {
    if (onToggleTask === undefined) return
    const boxes = prepareBoxes(hostRef.current, source)
    const said = pending.current === null ? null : settleToggle(boxes, pending.current)
    if (said === null) return
    pending.current = null
    setAnnouncement(said)
  }, [keyed, onToggleTask, source])
  return { hostRef, announcement, handlers: onToggleTask ? activationHandlers(toggleFrom) : {} }
}

function activationHandlers(
  toggleFrom: (target: EventTarget | null, at?: { x: number; y: number }) => boolean,
) {
  return {
    onClick: (event: MouseEvent<HTMLDivElement>) => {
      toggleFrom(
        event.target,
        plainPress(event) ? { x: event.clientX, y: event.clientY } : undefined,
      )
    },
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if ((event.key === 'Enter' || event.key === ' ') && toggleFrom(event.target)) {
        event.preventDefault()
      }
    },
  }
}
